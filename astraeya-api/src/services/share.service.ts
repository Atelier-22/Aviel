/**
 * Share links: a link to one made file that works for anyone holding it, with
 * no account. Nothing is shared until its owner makes a link. Each link is a
 * random 192-bit token; only its SHA-256 is stored. Links expire, can be
 * revoked, and stop working when the file itself is deleted.
 */

import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db";

export const SHARE_EXPIRY_CHOICES = [1, 7, 30] as const;

export interface ShareLinkForClient {
  id: string;
  /** Present only when the link is created; the token is not kept. */
  url?: string;
  expiresAt: string | null;
  revoked: boolean;
  downloads: number;
  createdAt: string;
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

type ShareRow = typeof schema.shareLinks.$inferSelect;

function toClient(row: ShareRow, url?: string): ShareLinkForClient {
  return {
    id: row.id,
    ...(url ? { url } : {}),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revoked: Boolean(row.revokedAt),
    downloads: row.downloads,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function createShareLink(fileId: string, userId: string, expiresInDays: number): Promise<ShareLinkForClient> {
  const token = randomBytes(24).toString("base64url");
  const [row] = await db
    .insert(schema.shareLinks)
    .values({
      fileId,
      userId,
      tokenHash: hash(token),
      expiresAt: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000),
    })
    .returning();
  // Relative to the API base URL, like download links.
  return toClient(row, `/share/${token}`);
}

export async function listShareLinks(fileId: string, userId: string): Promise<ShareLinkForClient[]> {
  const rows = await db.query.shareLinks.findMany({
    where: and(eq(schema.shareLinks.fileId, fileId), eq(schema.shareLinks.userId, userId)),
    orderBy: [desc(schema.shareLinks.createdAt)],
  });
  return rows.map((r) => toClient(r));
}

export async function revokeShareLink(shareId: string, userId: string): Promise<boolean> {
  const rows = await db
    .update(schema.shareLinks)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.shareLinks.id, shareId), eq(schema.shareLinks.userId, userId), isNull(schema.shareLinks.revokedAt)))
    .returning({ id: schema.shareLinks.id });
  return rows.length > 0;
}

/** The file a token opens, or null if the link is unknown, revoked or expired. */
export async function resolveShareLink(token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const link = await db.query.shareLinks.findFirst({ where: eq(schema.shareLinks.tokenHash, hash(token)) });
  if (!link || link.revokedAt || (link.expiresAt && link.expiresAt < new Date())) return null;
  const file = await db.query.generatedFiles.findFirst({ where: eq(schema.generatedFiles.id, link.fileId) });
  if (!file) return null;
  await db
    .update(schema.shareLinks)
    .set({ downloads: link.downloads + 1 })
    .where(eq(schema.shareLinks.id, link.id));
  return file;
}
