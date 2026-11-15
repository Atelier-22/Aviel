import { Router } from "express";
import { z } from "zod";
import { requireAuth, asyncHandler } from "../auth/middleware";
import { getPlatformConfig } from "../settings/platform";
import { DEFAULT_VOICE, FAST_VOICE, VOICES, normalizeVoiceId, voiceLabel } from "../voice/catalogue";
import { splitSentences } from "../voice/sentences";
import {
  VoiceUnavailable,
  liveVoiceFor,
  preview,
  synthesize,
  takeVoiceAllowance,
  voiceServiceUp,
} from "../voice/voice.service";

export const voiceRouter = Router();
voiceRouter.use(requireAuth);

async function voiceAllowed(res: import("express").Response): Promise<boolean> {
  const config = await getPlatformConfig();
  if (!config.features.voice) {
    res.status(503).json({ error: "Voice is currently unavailable. An administrator has turned it off." });
    return false;
  }
  return true;
}

/** The voices to choose from, grouped by the client, and whether the server is up. */
voiceRouter.get(
  "/voices",
  asyncHandler(async (_req, res) => {
    res.json({
      default: DEFAULT_VOICE,
      available: await voiceServiceUp(),
      fastVoices: FAST_VOICE,
      voices: VOICES.map((v) => ({ ...v, label: voiceLabel(v) })),
    });
  })
);

/** A short sample of one voice, for the picker's play button. Cached. */
voiceRouter.get(
  "/preview/:voice",
  asyncHandler(async (req, res) => {
    if (!(await voiceAllowed(res))) return;
    const limited = takeVoiceAllowance(req.userId!, 80);
    if (limited) {
      res.status(429).json({ error: limited });
      return;
    }
    try {
      const speech = await preview(req.params.voice);
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.setHeader("X-Voice-Id", speech.voice);
      res.end(speech.wav);
    } catch (err) {
      if (err instanceof VoiceUnavailable) {
        res.status(503).json({ error: "The voice service is not available right now." });
        return;
      }
      throw err;
    }
  })
);

const speakSchema = z.object({
  text: z.string().min(1).max(20_000),
  voice: z.string().max(120).optional(),
  /** "live" may switch to a fast voice; "read" always uses the chosen one. */
  mode: z.enum(["read", "live"]).default("read"),
});

/**
 * Speech for a piece of text, streamed sentence by sentence.
 *
 * The response is a sequence of frames, one per sentence:
 *   [4-byte length][JSON header][4-byte length][WAV bytes]
 * The header says which sentence it is and which voice spoke it. A header
 * with "error" set (and no audio after it) means the rest could not be made;
 * the client then falls back to the browser's voice for what is left.
 */
voiceRouter.post(
  "/speak",
  asyncHandler(async (req, res) => {
    if (!(await voiceAllowed(res))) return;
    const parsed = speakSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
      return;
    }
    const sentences = splitSentences(parsed.data.text);
    if (sentences.length === 0) {
      res.status(204).end();
      return;
    }
    const limited = takeVoiceAllowance(req.userId!, sentences.join(" ").length);
    if (limited) {
      res.status(429).json({ error: limited });
      return;
    }

    const chosen = normalizeVoiceId(parsed.data.voice);
    const { voice, substituted } = parsed.data.mode === "live" ? liveVoiceFor(chosen) : { voice: chosen, substituted: false };

    const abort = new AbortController();
    res.on("close", () => abort.abort());

    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
      "X-Voice-Id": voice,
      ...(substituted ? { "X-Voice-Substituted": chosen } : {}),
    });

    const frame = (header: Record<string, unknown>, audio?: Buffer) => {
      const head = Buffer.from(JSON.stringify(header), "utf8");
      const len = Buffer.alloc(4);
      len.writeUInt32BE(head.length);
      const parts: Buffer[] = [len, head];
      const alen = Buffer.alloc(4);
      alen.writeUInt32BE(audio?.length ?? 0);
      parts.push(alen);
      if (audio) parts.push(audio);
      res.write(Buffer.concat(parts));
    };

    for (let i = 0; i < sentences.length; i++) {
      if (abort.signal.aborted) break;
      try {
        const speech = await synthesize(sentences[i], voice, abort.signal);
        frame({ index: i, count: sentences.length, text: sentences[i], voice: speech.voice, seconds: speech.seconds, substituted }, speech.wav);
      } catch (err) {
        if (abort.signal.aborted) break;
        frame({
          index: i,
          count: sentences.length,
          error: err instanceof VoiceUnavailable ? "unavailable" : "failed",
          remaining: sentences.slice(i),
        });
        break;
      }
    }
    res.end();
  })
);
