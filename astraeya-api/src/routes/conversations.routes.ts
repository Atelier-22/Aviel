import { Router } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { filesByMessage } from "../services/files.service";
import { jobsByMessage } from "../services/media.service";
import { requireAuth, asyncHandler } from "../auth/middleware";

export const conversationsRouter = Router();

conversationsRouter.use(requireAuth);

conversationsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const conversations = await db.query.conversations.findMany({
      where: eq(schema.conversations.userId, req.userId!),
      // Pinned first, then most recently active. Ordering here rather than in
      // the client keeps every caller — web, mobile, future ones — consistent.
      orderBy: [
        desc(schema.conversations.pinned),
        desc(schema.conversations.updatedAt),
      ],
      columns: {
        id: true,
        title: true,
        updatedAt: true,
        projectId: true,
        pinned: true,
      },
    });
    res.json(conversations);
  })
);

conversationsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const conversation = await db.query.conversations.findFirst({
      where: and(
        eq(schema.conversations.id, req.params.id),
        eq(schema.conversations.userId, req.userId!)
      ),
      with: {
        messages: {
          orderBy: [asc(schema.messages.createdAt)],
          // Extracted document text can be very large and is for the model,
          // not the screen.
          columns: { documentText: false },
        },
      },
    });

    if (!conversation) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    // Made files under the replies they came with, each with a fresh link.
    // The sandbox id is the server's business only.
    const files = await filesByMessage(req.userId!, conversation.id);
    // Videos still being made (or that failed) under the reply that started them.
    const jobs = await jobsByMessage(req.userId!, conversation.id);
    const { sandboxId: _sandbox, ...rest } = conversation;
    res.json({
      ...rest,
      messages: rest.messages.map((m) => ({
        ...m,
        ...(files[m.id] ? { files: files[m.id] } : {}),
        ...(jobs[m.id] ? { jobs: jobs[m.id] } : {}),
      })),
    });
  })
);

/**
 * Branch a conversation: a new chat holding a copy of everything up to and
 * including one message, so the user can take the conversation in another
 * direction without losing the original.
 */
conversationsRouter.post(
  "/:id/branch",
  asyncHandler(async (req, res) => {
    const messageId =
      typeof req.body?.messageId === "string" ? req.body.messageId : null;
    if (!messageId) {
      res.status(400).json({ error: "messageId is required" });
      return;
    }

    const source = await db.query.conversations.findFirst({
      where: and(
        eq(schema.conversations.id, req.params.id),
        eq(schema.conversations.userId, req.userId!)
      ),
      with: { messages: { orderBy: [asc(schema.messages.createdAt)] } },
    });
    if (!source) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const cut = source.messages.findIndex((m) => m.id === messageId);
    if (cut === -1) {
      res.status(404).json({ error: "That message is not in this conversation" });
      return;
    }
    const kept = source.messages.slice(0, cut + 1);

    const branch = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(schema.conversations)
        .values({
          userId: req.userId!,
          title: `Branch · ${source.title}`.slice(0, 120),
          projectId: source.projectId,
          excludeFromMemory: source.excludeFromMemory,
        })
        .returning();

      // Original timestamps are kept so the copy reads in the same order.
      await tx.insert(schema.messages).values(
        kept.map((m) => ({
          conversationId: created.id,
          role: m.role,
          content: m.content,
          documentText: m.documentText,
          createdAt: m.createdAt,
        }))
      );
      return created;
    });

    res.status(201).json({ id: branch.id, title: branch.title });
  })
);

conversationsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const title = typeof req.body?.title === "string" ? req.body.title : null;
    const pinned =
      typeof req.body?.pinned === "boolean" ? req.body.pinned : undefined;

    if (title !== null && !title.trim()) {
      res.status(400).json({ error: "A title cannot be empty" });
      return;
    }
    if (title === null && pinned === undefined) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }

    const updated = await db
      .update(schema.conversations)
      .set({
        ...(title ? { title: title.trim() } : {}),
        ...(pinned !== undefined ? { pinned } : {}),
        // Pinning shouldn't reorder the list as if the chat had new activity.
        ...(title ? { updatedAt: new Date() } : {}),
      })
      .where(
        and(
          eq(schema.conversations.id, req.params.id),
          eq(schema.conversations.userId, req.userId!)
        )
      )
      .returning();

    if (updated.length === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ success: true });
  })
);

conversationsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const deleted = await db
      .delete(schema.conversations)
      .where(
        and(
          eq(schema.conversations.id, req.params.id),
          eq(schema.conversations.userId, req.userId!)
        )
      )
      .returning({ id: schema.conversations.id });

    if (deleted.length === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ success: true });
  })
);
