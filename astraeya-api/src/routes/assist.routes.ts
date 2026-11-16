import { Router } from "express";
import { z } from "zod";
import { requireAuth, asyncHandler } from "../auth/middleware";
import {
  buildMessageHistory,
  buildSystemPrompt,
  getChatContext,
  getOrCreateConversation,
  maybeTitleConversation,
  recordTokens,
  recordUsage,
  saveMessage,
} from "../services/chat.service";
import { memoryPromptBlock } from "../services/prompt.service";
import { availableModels, providerForModel, resolveModelId } from "../ai";
import type { ClientTool, StreamChunk } from "../ai/provider.interface";
import { checkLimit } from "../services/limits.service";
import { getPlatformConfig } from "../settings/platform";

/**
 * Astra Assist: the Windows companion. The desktop app sends what the person
 * asked, a screenshot of the screen they are looking at and where the cursor
 * is; the reply is spoken back, and may point at a spot on the screen or put a
 * draft on the clipboard. It lives in the person's normal conversations.
 */
export const assistRouter = Router();
assistRouter.use(requireAuth);

const askSchema = z.object({
  question: z.string().min(1).max(4000),
  conversationId: z.string().optional(),
  screenshot: z
    .object({
      mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
      base64: z.string().min(100),
      /** Pixel size of the screenshot as sent (after any downscaling). */
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .optional(),
  /** The cursor, in the screenshot's pixels. */
  cursor: z.object({ x: z.number(), y: z.number() }).optional(),
  /** The window the person is in, e.g. "Cisco Packet Tracer". */
  activeWindow: z.string().max(300).optional(),
});

const ASSIST_NOTE = (shot: { width: number; height: number } | undefined, cursor: { x: number; y: number } | undefined, active?: string) =>
  `\n\nYou are Astra Assist, the person's companion on their Windows PC. They called you with a hotkey and are talking to you out loud while they work. ${
    shot
      ? `A screenshot of their screen (${shot.width} x ${shot.height} pixels) is attached to their latest message${
          cursor ? `; their mouse cursor is at x=${Math.round(cursor.x)}, y=${Math.round(cursor.y)}` : ""
        }${active ? `; the active window is "${active}"` : ""}. Read it carefully before answering.`
      : "No screenshot came with this message."
  }
How to answer:
- Speak first: your first sentence is spoken the moment you write it, so always write a short first sentence with the answer before calling any tool, then call point_at or copy_to_clipboard, then finish.
- Your words are spoken aloud. Answer in one to four short, plain spoken sentences, starting with the answer. No Markdown, lists, headings, code blocks or emoji.
- Guide, do not act: you cannot click or type for them. Say exactly what to do next: which field, which button, what to type. Spell out commands they must type, e.g. "type: ip address 192.168.1.1 255.255.255.0".
- Look for mistakes on screen (a typo in a command, a wrong field, a missing step) and point them out plainly and kindly.
- When a specific spot on the screen matters (a button, a field, an error, a line), call point_at with its pixel position in the screenshot, so a pointer appears there.
- When they want text they will paste (an email reply, a message, a command, a paragraph), write it in full and call copy_to_clipboard with exactly that text, then tell them briefly that it is copied and they can press Ctrl+V. Match the tone they ask for; professional by default for emails. If they ask for another version, write a new one and copy that instead.
- If the screenshot does not show what they are asking about, say what you can see and ask them to show it (for example to scroll or open the window).`;

const POINT_SCHEMA = {
  type: "object",
  properties: {
    x: { type: "number", description: "Horizontal pixel position in the screenshot." },
    y: { type: "number", description: "Vertical pixel position in the screenshot." },
    label: { type: "string", description: "Two to five words naming what is there, e.g. 'Save button'." },
  },
  required: ["x", "y"],
};

const CLIPBOARD_SCHEMA = {
  type: "object",
  properties: { text: { type: "string", description: "Exactly the text to put on the clipboard." } },
  required: ["text"],
};

assistRouter.post(
  "/ask",
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const parsed = askSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
      return;
    }
    const { question, screenshot, cursor, activeWindow } = parsed.data;

    const config = await getPlatformConfig();
    if (!config.features.chat) {
      res.status(503).json({ error: "Astraeya is currently unavailable." });
      return;
    }
    const allowance = await checkLimit(userId, "message");
    if (!allowance.allowed) {
      res.status(429).json({ error: allowance.message });
      return;
    }

    const { user, settings, memoryEntries } = await getChatContext(userId);
    const pickable = new Set(availableModels().map((m) => m.value));
    const model = pickable.has(settings.ai.defaultModel) ? settings.ai.defaultModel : "standard";
    const provider = providerForModel(model);
    if (!provider.isConfigured() || provider.id !== "anthropic") {
      res.status(503).json({ error: "Astra Assist needs Astraeya's hosted models, which are not available right now." });
      return;
    }

    const conversation = await getOrCreateConversation({ userId, conversationId: parsed.data.conversationId });
    if ((conversation.messages?.length ?? 0) === 0) {
      await maybeTitleConversation(conversation.id, `Astra Assist: ${question.slice(0, 40)}`);
    }
    await saveMessage(conversation.id, "user", screenshot ? `${question}\n\n[Shared my screen]` : question);
    await recordUsage(userId, "message", 1, model);

    const history = await buildMessageHistory(conversation.id);
    // The screenshot rides on this turn only; it is never stored.
    if (screenshot && history.length > 0) {
      history[history.length - 1].images = [{ mediaType: screenshot.mediaType, data: screenshot.base64 }];
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("meta", { conversationId: conversation.id, model });

    const tools: ClientTool[] = [
      {
        name: "point_at",
        description: "Show a pointer at a spot on the person's screen: a button, field, error or line they should look at or click. Coordinates are pixels in the attached screenshot.",
        inputSchema: POINT_SCHEMA,
        status: "Pointing…",
        run: async (input) => {
          const x = Number(input.x);
          const y = Number(input.y);
          if (!screenshot || !Number.isFinite(x) || !Number.isFinite(y)) return { content: "No screenshot to point at.", isError: true };
          send("point", {
            x: Math.min(Math.max(x, 0), screenshot.width),
            y: Math.min(Math.max(y, 0), screenshot.height),
            label: typeof input.label === "string" ? input.label.slice(0, 60) : undefined,
          });
          return { content: "The pointer is showing there now." };
        },
      },
      {
        name: "copy_to_clipboard",
        description: "Put text on the person's clipboard so they can paste it with Ctrl+V: an email reply, a message, a command, a paragraph. Use exactly the final text.",
        inputSchema: CLIPBOARD_SCHEMA,
        status: "Copying…",
        run: async (input) => {
          const text = typeof input.text === "string" ? input.text : "";
          if (!text.trim()) return { content: "Nothing to copy.", isError: true };
          send("clipboard", { text: text.slice(0, 20_000) });
          return { content: "Copied to their clipboard. Tell them they can press Ctrl+V to paste it." };
        },
      },
    ];

    let reply = "";
    let failed: string | null = null;
    let closed = false;
    req.on("close", () => (closed = true));

    const stable = buildSystemPrompt({ user, settings, projectInstructions: null });
    const notes = memoryPromptBlock(memoryEntries) + ASSIST_NOTE(screenshot, cursor, activeWindow);
    const stream = provider.streamCompletion(history, {
      systemPrompt: stable + notes,
      stableSystemPrompt: stable,
      turnNotes: notes,
      model: resolveModelId(model),
      effort: "low",
      maxTokens: 4096,
      tools,
    });

    // Text resumes after a tool call as a new block; a space keeps the two
    // sentences apart ("…two. I've copied…", not "…two.I've copied…").
    let afterTool = false;
    for await (const chunk of stream as AsyncGenerator<StreamChunk>) {
      if (closed) break;
      if (chunk.type === "text" && chunk.text) {
        let text = chunk.text;
        if (afterTool && reply && !/\s$/.test(reply) && !/^\s/.test(text)) text = ` ${text}`;
        afterTool = false;
        reply += text;
        send("chunk", { text });
      } else if (chunk.type === "status") {
        afterTool = true;
        send("status", { text: chunk.status });
      } else if (chunk.type === "usage" && chunk.usage) {
        await recordTokens(userId, model, chunk.usage);
      } else if (chunk.type === "error") {
        failed = chunk.error ?? "Something went wrong.";
      }
    }

    if (reply.trim()) await saveMessage(conversation.id, "assistant", reply);
    if (!closed) {
      if (failed && !reply.trim()) send("error", { message: failed });
      send("done", {});
    }
    res.end();
  })
);
