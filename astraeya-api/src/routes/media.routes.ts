import { Router } from "express";
import { requireAuth, asyncHandler } from "../auth/middleware";
import { findOwnedJob, jobForClient, kickWorker } from "../services/media.service";
import { db, schema } from "../db";
import { eq } from "drizzle-orm";

export const mediaRouter = Router();

/** One video job's progress, polled by the chat while it is being made. */
mediaRouter.get(
  "/jobs/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const job = await findOwnedJob(req.params.id, req.userId!);
    if (!job) {
      res.status(404).json({ error: "Video not found" });
      return;
    }
    res.json(await jobForClient(job));
  })
);

/**
 * The media service calls this when a video finishes. The body is not
 * trusted: it only prompts an early poll, which reads the result from the
 * service itself. Knowing a job id gains a caller nothing more than that.
 */
mediaRouter.post(
  "/webhook/:jobId",
  asyncHandler(async (req, res) => {
    const job = await db.query.mediaJobs.findFirst({
      where: eq(schema.mediaJobs.id, req.params.jobId),
      columns: { id: true },
    });
    if (job) kickWorker();
    res.status(204).end();
  })
);
