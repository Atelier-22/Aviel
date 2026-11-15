/**
 * Files Astraeya makes for a user: documents, slides, spreadsheets, charts and
 * edited images.
 *
 * The bytes stay in the AI provider's file store. Astraeya keeps a row per
 * file that says whose it is, and hands out short-lived signed links to it.
 * A link names only Astraeya's own file id and a signature, never where the
 * bytes are kept, and it stops working after DOWNLOAD_LINK_TTL.
 *
 * Links are signed, not session-authenticated, on purpose: a phone opening a
 * download in its browser or a download manager does not carry the app's
 * bearer token.
 */

import jwt from "jsonwebtoken";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db";
import { env } from "../env";
import type { MadeFile } from "../ai/provider.interface";
import { deleteStoredFile } from "../ai/file-store";

/** How long a download link works. Reloading the chat issues fresh ones. */
export const DOWNLOAD_LINK_TTL_SECONDS = 60 * 60;

/** Kept apart from login tokens, so neither can be used as the other. */
const AUDIENCE = "astraeya-file-download";

export interface FileForClient {
  id: string;
  filename: string;
  mediaType: string;
  sizeBytes: number | null;
  /** Signed, expiring, relative to the API base URL. */
  url: string;
  expiresAt: string;
}

export function signDownload(fileId: string, userId: string): { token: string; expiresAt: Date } {
  const token = jwt.sign({ f: fileId, u: userId }, env.JWT_SECRET, {
    audience: AUDIENCE,
    expiresIn: DOWNLOAD_LINK_TTL_SECONDS,
  });
  return { token, expiresAt: new Date(Date.now() + DOWNLOAD_LINK_TTL_SECONDS * 1000) };
}

/** The file id and owner a link was issued for, or null if it is forged or expired. */
export function verifyDownload(token: string): { fileId: string; userId: string } | null {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, { audience: AUDIENCE }) as {
      f?: unknown;
      u?: unknown;
    };
    if (typeof payload.f !== "string" || typeof payload.u !== "string") return null;
    return { fileId: payload.f, userId: payload.u };
  } catch {
    return null;
  }
}

type FileRow = typeof schema.generatedFiles.$inferSelect;

export function toClientFile(row: FileRow): FileForClient {
  const { token, expiresAt } = signDownload(row.id, row.userId);
  return {
    id: row.id,
    filename: row.filename,
    mediaType: row.mediaType,
    sizeBytes: row.sizeBytes,
    url: `/files/${row.id}/download?token=${encodeURIComponent(token)}`,
    expiresAt: expiresAt.toISOString(),
  };
}

/** Records a file the model just made. It is tied to its reply once that is saved. */
export async function recordMadeFile(params: {
  userId: string;
  conversationId: string;
  file: MadeFile;
}): Promise<FileRow> {
  const [row] = await db
    .insert(schema.generatedFiles)
    .values({
      userId: params.userId,
      conversationId: params.conversationId,
      providerFileId: params.file.providerFileId,
      filename: safeFilename(params.file.filename),
      mediaType: params.file.mediaType,
      sizeBytes: params.file.sizeBytes,
    })
    .returning();
  return row;
}

export async function attachFilesToMessage(fileIds: string[], messageId: string) {
  if (fileIds.length === 0) return;
  await db
    .update(schema.generatedFiles)
    .set({ messageId })
    .where(inArray(schema.generatedFiles.id, fileIds));
}

/** Files under each reply of a conversation, keyed by message id, with fresh links. */
export async function filesByMessage(
  userId: string,
  conversationId: string
): Promise<Record<string, FileForClient[]>> {
  const rows = await db.query.generatedFiles.findMany({
    where: and(
      eq(schema.generatedFiles.userId, userId),
      eq(schema.generatedFiles.conversationId, conversationId)
    ),
    orderBy: [schema.generatedFiles.createdAt],
  });
  const out: Record<string, FileForClient[]> = {};
  for (const row of rows) {
    if (!row.messageId) continue;
    (out[row.messageId] ??= []).push(toClientFile(row));
  }
  return out;
}

/** Everything a user has had made, newest first, for the Library. */
export async function listUserFiles(userId: string, limit = 100): Promise<FileForClient[]> {
  const rows = await db.query.generatedFiles.findMany({
    where: eq(schema.generatedFiles.userId, userId),
    orderBy: [desc(schema.generatedFiles.createdAt)],
    limit,
  });
  return rows.map(toClientFile);
}

export async function findOwnedFile(fileId: string, userId: string): Promise<FileRow | null> {
  const row = await db.query.generatedFiles.findFirst({
    where: and(
      eq(schema.generatedFiles.id, fileId),
      eq(schema.generatedFiles.userId, userId)
    ),
  });
  return row ?? null;
}

/**
 * A filename that is safe to put in a Content-Disposition header and on a
 * phone's file system: no path, no control characters, a sane length.
 */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "file";
  if (cleaned.length <= 120) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : "";
  return cleaned.slice(0, 120 - ext.length) + ext;
}

/** RFC 6266 header with an ASCII fallback, so non-English names survive. */
export function contentDisposition(filename: string, inline: boolean): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/\\/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Removes every file made for a user, from the provider's store as well as
 * here. Run when an account is erased or deleted: a row cascading away would
 * otherwise leave the bytes behind with nothing pointing at them.
 */
export async function purgeUserFiles(userId: string): Promise<void> {
  const rows = await db.query.generatedFiles.findMany({
    where: eq(schema.generatedFiles.userId, userId),
    columns: { providerFileId: true },
  });
  await Promise.all(rows.map((r) => deleteStoredFile(r.providerFileId)));
  await db.delete(schema.generatedFiles).where(eq(schema.generatedFiles.userId, userId));
}

/** Whether the latest reply in a conversation came with a file. */
export async function lastReplyMadeFile(conversationId: string): Promise<boolean> {
  const last = await db.query.messages.findFirst({
    where: and(
      eq(schema.messages.conversationId, conversationId),
      eq(schema.messages.role, "assistant")
    ),
    orderBy: [desc(schema.messages.createdAt)],
    columns: { id: true },
  });
  if (!last) return false;
  const file = await db.query.generatedFiles.findFirst({
    where: eq(schema.generatedFiles.messageId, last.id),
    columns: { id: true },
  });
  return Boolean(file);
}
