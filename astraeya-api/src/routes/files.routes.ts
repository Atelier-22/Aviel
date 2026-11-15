import { Router } from "express";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { requireAuth, asyncHandler } from "../auth/middleware";
import {
  contentDisposition,
  findOwnedFile,
  listUserFiles,
  toClientFile,
  verifyDownload,
} from "../services/files.service";
import { deleteStoredFile, openStoredFile } from "../ai/file-store";
import { z } from "zod";
import {
  SHARE_EXPIRY_CHOICES,
  createShareLink,
  listShareLinks,
  resolveShareLink,
  revokeShareLink,
} from "../services/share.service";

export const filesRouter = Router();

/** Types a browser may show in place; everything else is downloaded. */
const INLINE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "video/mp4",
  "video/webm",
]);

type FileRow = NonNullable<Awaited<ReturnType<typeof findOwnedFile>>>;

/** Streams a made file from the store, with headers that keep it inert. */
async function sendStoredFile(res: import("express").Response, row: FileRow, wantInline: boolean) {
  let upstream: Response;
  try {
    upstream = await openStoredFile(row.providerFileId);
  } catch (err) {
    console.error("File download failed:", err instanceof Error ? err.message : err);
    res.status(502).json({ error: "The file could not be fetched right now. Try again shortly." });
    return;
  }

  const inline = wantInline && INLINE_TYPES.has(row.mediaType);
  res.setHeader("Content-Type", row.mediaType);
  res.setHeader("Content-Disposition", contentDisposition(row.filename, inline));
  // Private to the person holding the link; never stored by a shared cache.
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // A made .html or .svg file must never run as a page on this domain.
  // Previews (images, PDFs and video only) go without it: Chrome refuses to
  // show a PDF in a sandboxed page.
  if (!inline) {
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
  }
  const length = upstream.headers.get("content-length");
  if (length) res.setHeader("Content-Length", length);

  if (!upstream.body) {
    res.end();
    return;
  }
  Readable.fromWeb(upstream.body as unknown as WebReadableStream).pipe(res);
}

/** The account's made files, newest first, each with a fresh link. */
filesRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ files: await listUserFiles(req.userId!) });
  })
);

/** A fresh link for one file, for when the one on screen has expired. */
filesRouter.get(
  "/:id/link",
  requireAuth,
  asyncHandler(async (req, res) => {
    const row = await findOwnedFile(req.params.id, req.userId!);
    if (!row) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    res.json(toClientFile(row));
  })
);

/**
 * The download itself. Authorised by the signed token in the link rather than
 * a session, so it opens from a phone's browser or download manager. The token
 * names the owner, and the row must still belong to them.
 */
filesRouter.get(
  "/:id/download",
  asyncHandler(async (req, res) => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    const claim = verifyDownload(token);
    if (!claim || claim.fileId !== req.params.id) {
      res.status(403).json({
        error: "This download link has expired. Open the chat again to get a fresh one.",
      });
      return;
    }

    const row = await findOwnedFile(claim.fileId, claim.userId);
    if (!row) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    await sendStoredFile(res, row, req.query.inline === "1");
  })
);

const shareSchema = z.object({
  expiresInDays: z
    .number()
    .int()
    .refine((n) => (SHARE_EXPIRY_CHOICES as readonly number[]).includes(n), "Choose 1, 7 or 30 days")
    .default(7),
});

/** Makes a share link for one file. The full link is returned only now. */
filesRouter.post(
  "/:id/share",
  requireAuth,
  asyncHandler(async (req, res) => {
    const row = await findOwnedFile(req.params.id, req.userId!);
    if (!row) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    const parsed = shareSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
      return;
    }
    res.status(201).json(await createShareLink(row.id, req.userId!, parsed.data.expiresInDays));
  })
);

filesRouter.get(
  "/:id/shares",
  requireAuth,
  asyncHandler(async (req, res) => {
    const row = await findOwnedFile(req.params.id, req.userId!);
    if (!row) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    res.json({ links: await listShareLinks(row.id, req.userId!) });
  })
);

filesRouter.delete(
  "/shares/:shareId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const ok = await revokeShareLink(req.params.shareId, req.userId!);
    res.status(ok ? 204 : 404).end();
  })
);

/**
 * The public side of a share link: no account needed. Pictures, PDFs and
 * videos open in the browser; everything else downloads.
 */
export const shareRouter = Router();

shareRouter.get(
  "/:token",
  asyncHandler(async (req, res) => {
    const row = await resolveShareLink(req.params.token);
    if (!row) {
      res
        .status(404)
        .type("text/plain")
        .send("This link has expired or been turned off. Ask the person who shared it for a new one.");
      return;
    }
    await sendStoredFile(res, row, req.query.download !== "1");
  })
);

/** Deletes a made file, here and in the provider's store. */
filesRouter.delete(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const row = await findOwnedFile(req.params.id, req.userId!);
    if (!row) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    await db.delete(schema.generatedFiles).where(eq(schema.generatedFiles.id, row.id));
    await deleteStoredFile(row.providerFileId);
    res.status(204).end();
  })
);
