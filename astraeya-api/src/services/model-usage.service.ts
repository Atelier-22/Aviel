/**
 * Usage per person and per model: messages, tokens and estimated cost. This
 * is what tells us that someone leans on Athena 2.5 and uses a lot of power,
 * or answers everything with Lotus.
 */

import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { availableModels } from "../ai";
import { estimateCost } from "../ai/pricing";

export interface ModelUsage {
  model: string;
  label: string;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** US dollars, estimated from tokens and list prices. */
  estimatedCost: number;
}

const TYPES = ["message", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"];

function labelFor(model: string): string {
  return availableModels().find((m) => m.value === model)?.label ?? model;
}

function since(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/** Rows of (user, model, type, total) in the window, optionally for one user. */
async function totals(days: number, userId?: string) {
  return db
    .select({
      userId: schema.usageRecords.userId,
      model: schema.usageRecords.model,
      type: schema.usageRecords.type,
      total: sql<number>`coalesce(sum(${schema.usageRecords.amount}), 0)::bigint`,
    })
    .from(schema.usageRecords)
    .where(
      and(
        gte(schema.usageRecords.createdAt, since(days)),
        isNotNull(schema.usageRecords.model),
        sql`${schema.usageRecords.type} in (${sql.join(TYPES.map((t) => sql`${t}`), sql`, `)})`,
        ...(userId ? [eq(schema.usageRecords.userId, userId)] : [])
      )
    )
    .groupBy(schema.usageRecords.userId, schema.usageRecords.model, schema.usageRecords.type);
}

function fold(rows: Awaited<ReturnType<typeof totals>>, key: (r: (typeof rows)[number]) => string) {
  const out = new Map<string, ModelUsage & { userId: string }>();
  for (const r of rows) {
    const model = r.model ?? "unknown";
    const k = key(r);
    const u =
      out.get(k) ??
      { userId: r.userId, model, label: labelFor(model), messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCost: 0 };
    const n = Number(r.total);
    if (r.type === "message") u.messages += n;
    else if (r.type === "input_tokens") u.inputTokens += n;
    else if (r.type === "output_tokens") u.outputTokens += n;
    else if (r.type === "cache_read_tokens") u.cacheReadTokens += n;
    else if (r.type === "cache_write_tokens") u.cacheWriteTokens += n;
    out.set(k, u);
  }
  for (const u of out.values()) u.estimatedCost = estimateCost(u.model, u);
  return [...out.values()];
}

/** One person's usage by model. */
export async function usageByModel(userId: string, days = 30): Promise<ModelUsage[]> {
  return fold(await totals(days, userId), (r) => r.model ?? "unknown").map(({ userId: _u, ...rest }) => rest);
}

/** Everyone's usage by person and model, heaviest first, plus totals per model. */
export async function usageByUserAndModel(days = 30) {
  const rows = await totals(days);
  const perUserModel = fold(rows, (r) => `${r.userId}\n${r.model}`);
  const perModel = fold(rows, (r) => r.model ?? "unknown").map(({ userId: _u, ...rest }) => rest);

  const users = await db.query.users.findMany({ columns: { id: true, email: true, displayName: true } });
  const byId = new Map(users.map((u) => [u.id, u]));
  const people = new Map<string, { userId: string; email: string | null; name: string | null; estimatedCost: number; models: ModelUsage[] }>();
  for (const u of perUserModel) {
    const p =
      people.get(u.userId) ??
      { userId: u.userId, email: byId.get(u.userId)?.email ?? null, name: byId.get(u.userId)?.displayName ?? null, estimatedCost: 0, models: [] };
    const { userId: _u, ...usage } = u;
    p.models.push(usage);
    p.estimatedCost = Math.round((p.estimatedCost + u.estimatedCost) * 10_000) / 10_000;
    people.set(u.userId, p);
  }
  return {
    days,
    models: perModel,
    people: [...people.values()].sort((a, b) => b.estimatedCost - a.estimatedCost),
  };
}
