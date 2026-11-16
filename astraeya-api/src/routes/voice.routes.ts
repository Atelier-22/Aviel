import express, { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { requireAuth, asyncHandler } from "../auth/middleware";
import { db, schema } from "../db";
import { getPlatformConfig } from "../settings/platform";
import { loadSettings } from "../settings/store";
import { DEFAULT_VOICE, VOICES, normalizeVoiceId, voiceLabel } from "../voice/catalogue";
import { speechPieces, splitSentences } from "../voice/sentences";
import { hostedSpeechEnabled } from "../voice/hosted";
import {
  VoiceUnavailable,
  greetingFor,
  preview,
  synthesize,
  takeVoiceAllowance,
  transcribe,
  voiceServiceUp,
  warm,
} from "../voice/voice.service";

export const voiceRouter = Router();
voiceRouter.use(requireAuth);

/**
 * Pieces of speech being made at once for one request. The voice server
 * makes them on separate cores, so while the first plays the next ones are
 * already being made: that is what keeps the speech from pausing.
 */
const LOOKAHEAD = Math.max(1, Number(process.env.VOICE_PARALLEL ?? 4));

/** Silence after a piece, in seconds: a breath after a sentence, less after a comma. */
const PAUSE_AFTER_SENTENCE = 0.22;
const PAUSE_AFTER_CLAUSE = 0.06;

async function voiceAllowed(res: import("express").Response): Promise<boolean> {
  const config = await getPlatformConfig();
  if (!config.features.voice) {
    res.status(503).json({ error: "Voice is currently unavailable. An administrator has turned it off." });
    return false;
  }
  return true;
}

/** What to call the person: their preferred name, else their display name. */
async function nameFor(userId: string, profile: { preferredName: string | null; displayName: string | null }): Promise<string | null> {
  if (profile.preferredName?.trim()) return profile.preferredName;
  if (profile.displayName?.trim()) return profile.displayName;
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId), columns: { displayName: true } });
  return user?.displayName ?? null;
}

/** The voices to choose from, grouped by the client, and whether the server is up. */
voiceRouter.get(
  "/voices",
  asyncHandler(async (_req, res) => {
    res.json({
      default: DEFAULT_VOICE,
      available: hostedSpeechEnabled() || (await voiceServiceUp()),
      // Speech made by the hosted provider: the apps say so in their privacy text.
      hosted: hostedSpeechEnabled(),
      voices: VOICES.map((v) => ({ ...v, label: voiceLabel(v) })),
    });
  })
);

/**
 * Makes this person's live greeting ahead of time, in their voice, so it
 * plays the instant live mode opens. Called when the chat loads; returns at
 * once and does the work in the background.
 */
voiceRouter.post(
  "/warm",
  asyncHandler(async (req, res) => {
    const config = await getPlatformConfig();
    if (!config.features.voice) {
      res.status(204).end();
      return;
    }
    const settings = await loadSettings(req.userId!);
    const greeting = greetingFor(await nameFor(req.userId!, settings.profile));
    res.json({ greeting });
    void warm([greeting], settings.voice.outputVoice);
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
  /**
   * True for the start of a reply: its opening words, up to the first comma,
   * are made and played first. Later parts of a reply that is still
   * streaming send false.
   */
  first: z.boolean().default(true),
});

/**
 * Speech for a piece of text, streamed piece by piece in order.
 *
 * Frames, one per piece:
 *   [4-byte length][JSON header][4-byte length][WAV bytes]
 * The header has the piece's text, its voice and the pause to leave after it.
 * A header with "error" set (and no audio) means the rest could not be made;
 * the client then speaks what is left with the browser's voice.
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

    // The chosen voice, always: the same in chat, read-aloud and live.
    const voice = normalizeVoiceId(parsed.data.voice);
    const pieces = speechPieces(sentences, parsed.data.first);

    const abort = new AbortController();
    res.on("close", () => abort.abort());

    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
      "X-Voice-Id": voice,
    });
    res.flushHeaders();

    const frame = (header: Record<string, unknown>, audio?: Buffer) => {
      const head = Buffer.from(JSON.stringify(header), "utf8");
      const len = Buffer.alloc(4);
      len.writeUInt32BE(head.length);
      const alen = Buffer.alloc(4);
      alen.writeUInt32BE(audio?.length ?? 0);
      const parts: Buffer[] = [len, head, alen];
      if (audio) parts.push(audio);
      res.write(Buffer.concat(parts));
    };

    // Start the first few at once; each time one is sent, start the next.
    const jobs: Promise<Awaited<ReturnType<typeof synthesize>>>[] = [];
    const started = new Set<number>();
    const start = (i: number) => {
      if (i >= pieces.length || started.has(i)) return;
      started.add(i);
      jobs[i] = synthesize(pieces[i].text, voice, abort.signal);
      jobs[i].catch(() => undefined); // handled when its turn comes
    };
    for (let i = 0; i < Math.min(LOOKAHEAD, pieces.length); i++) start(i);

    for (let i = 0; i < pieces.length; i++) {
      if (abort.signal.aborted) break;
      start(i);
      try {
        const speech = await jobs[i];
        frame(
          {
            index: i,
            count: pieces.length,
            text: pieces[i].text,
            voice: speech.voice,
            seconds: speech.seconds,
            pause: pieces[i].endsSentence ? PAUSE_AFTER_SENTENCE : PAUSE_AFTER_CLAUSE,
          },
          speech.wav
        );
        start(i + LOOKAHEAD);
      } catch (err) {
        if (abort.signal.aborted) break;
        frame({
          index: i,
          count: pieces.length,
          error: err instanceof VoiceUnavailable ? "unavailable" : "failed",
          remaining: pieces.slice(i).map((p) => p.text),
        });
        break;
      }
    }
    res.end();
  })
);

/**
 * What the person said, as text: a WAV recording in, Whisper's words out.
 * Used by Astra Assist, where the browser's own recognition is not available.
 */
voiceRouter.post(
  "/transcribe",
  express.raw({ type: ["audio/wav", "audio/x-wav", "application/octet-stream"], limit: "25mb" }),
  asyncHandler(async (req, res) => {
    if (!(await voiceAllowed(res))) return;
    const audio = req.body as Buffer;
    if (!Buffer.isBuffer(audio) || audio.length < 1000) {
      res.status(400).json({ error: "Send the recording as WAV audio." });
      return;
    }
    // About 32 KB per second of 16 kHz mono audio; counted like characters.
    const limited = takeVoiceAllowance(req.userId!, Math.ceil(audio.length / 2000));
    if (limited) {
      res.status(429).json({ error: limited });
      return;
    }
    try {
      res.json(await transcribe(audio));
    } catch (err) {
      if (err instanceof VoiceUnavailable) {
        res.status(503).json({ error: "Speech recognition isn't available right now." });
        return;
      }
      throw err;
    }
  })
);
