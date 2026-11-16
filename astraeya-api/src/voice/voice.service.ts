/**
 * Talking to the voice server (astraeya-voice), which turns one sentence and
 * a voice id into a WAV. Everything user-facing goes through here:
 *
 * - an unknown voice id becomes af_heart, before anything is asked for
 * - identical sentences in the same voice are made once and then served
 *   from memory, and so are the preview clips
 * - the chosen voice is always the one used, in chat and live alike
 */

import { createHash } from "node:crypto";
import { env } from "../env";
import { DEFAULT_VOICE, findVoice, normalizeVoiceId } from "./catalogue";
import { speechPieces, splitSentences } from "./sentences";
import { normalizeForSpeech } from "./normalize";
import { hostedSpeak, hostedSpeechEnabled, hostedTranscribe, wavSeconds } from "./hosted";

export class VoiceUnavailable extends Error {}

export interface Speech {
  wav: Buffer;
  voice: string;
  seconds: number;
  cached: boolean;
}

function baseUrl(): string {
  const raw = env.VOICE_SERVICE_URL.trim().replace(/\/$/, "");
  // Render's private-service "hostport" has no scheme.
  return /^https?:\/\//.test(raw) ? raw : `http://${raw}`;
}

// ---------------------------------------------------------------------------
// Cache: least recently used, bounded by bytes
// ---------------------------------------------------------------------------

const CACHE_BYTES = 48 * 1024 * 1024;
const cache = new Map<string, Speech>();
let cacheBytes = 0;

function cacheKey(voice: string, text: string): string {
  return createHash("sha256").update(`${voice}\n${text}`).digest("hex");
}

function cacheGet(key: string): Speech | undefined {
  const hit = cache.get(key);
  if (hit) {
    // Re-insert to mark as recently used.
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

function cacheSet(key: string, speech: Speech) {
  if (speech.wav.length > CACHE_BYTES / 8) return;
  cache.set(key, speech);
  cacheBytes += speech.wav.length;
  for (const [k, v] of cache) {
    if (cacheBytes <= CACHE_BYTES) break;
    cache.delete(k);
    cacheBytes -= v.wav.length;
  }
}

export function cacheStats() {
  return { entries: cache.size, bytes: cacheBytes };
}

/** For tests. */
export function clearVoiceCache() {
  cache.clear();
  cacheBytes = 0;
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

/** Speech being made right now, so a second request for it waits rather than making it twice. */
const inFlight = new Map<string, Promise<Speech>>();

/** One piece of speech in one voice, from the cache if it has been made before. */
export async function synthesize(written: string, voiceId: string, signal?: AbortSignal): Promise<Speech> {
  // Said the way a person would say it: "2.4 GB" is "2 point four gigabytes".
  const text = normalizeForSpeech(written);
  const voice = normalizeVoiceId(voiceId);
  const key = cacheKey(voice, text);
  const hit = cacheGet(key);
  if (hit) return { ...hit, cached: true };
  const pending = inFlight.get(key);
  if (pending) return { ...(await pending), cached: true };
  // Made without the caller's abort signal: another request may be waiting
  // on the same piece, and the result is worth keeping in the cache anyway.
  const job = make(text, voice, key);
  inFlight.set(key, job);
  try {
    if (!signal) return await job;
    return await Promise.race([
      job,
      new Promise<never>((_, reject) =>
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })
      ),
    ]);
  } finally {
    job.finally(() => inFlight.delete(key)).catch(() => undefined);
  }
}

async function make(text: string, voice: string, key: string): Promise<Speech> {
  // Kokoro voices (Heart and the rest) from the hosted GPUs when switched on:
  // the same voice, in a fraction of the time. Any failure falls through to
  // our own voice server below.
  if (hostedSpeechEnabled() && findVoice(voice)?.engine === "kokoro") {
    try {
      const wav = await hostedSpeak(text, voice);
      const speech: Speech = { wav, voice, seconds: wavSeconds(wav), cached: false };
      cacheSet(key, speech);
      return speech;
    } catch (err) {
      console.warn("[voice] hosted speech failed, using our own server:", err instanceof Error ? err.message : err);
    }
  }
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/synthesize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.VOICE_SECRET ? { "X-Voice-Secret": env.VOICE_SECRET } : {}),
      },
      body: JSON.stringify({ text, voice }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    markDown();
    throw new VoiceUnavailable("The voice service could not be reached.");
  }
  if (!res.ok) {
    if (res.status >= 500 || res.status === 401) markDown();
    throw new VoiceUnavailable(`The voice service refused the request (${res.status}).`);
  }
  markUp();
  const wav = Buffer.from(await res.arrayBuffer());
  const seconds = Number(res.headers.get("x-audio-seconds") ?? 0);
  const speech: Speech = { wav, voice: res.headers.get("x-voice-id") ?? voice, seconds, cached: false };
  cacheSet(key, speech);
  return speech;
}

const PREVIEW_TEXT = (name: string) => `Hi, I'm ${name}. This is how I'll sound when I read your answers aloud.`;

/** A short clip of a voice, made once and kept. */
export function preview(voiceId: string): Promise<Speech> {
  const voice = normalizeVoiceId(voiceId);
  return synthesize(PREVIEW_TEXT(findVoice(voice)?.name ?? "Astraeya"), voice);
}

// ---------------------------------------------------------------------------
// Speech to text (Whisper, on the same voice server)
// ---------------------------------------------------------------------------

export interface Transcript {
  text: string;
  seconds: number;
}

/** WAV audio in, the words out. */
export async function transcribe(wav: Buffer): Promise<Transcript> {
  if (hostedSpeechEnabled()) {
    try {
      return { text: await hostedTranscribe(wav), seconds: wavSeconds(wav) };
    } catch (err) {
      console.warn("[voice] hosted transcription failed, using our own server:", err instanceof Error ? err.message : err);
    }
  }
  const raw = (env.VOICE_STT_URL ?? "").trim().replace(/\/$/, "");
  const sttUrl = raw ? (/^https?:\/\//.test(raw) ? raw : `http://${raw}`) : baseUrl();
  let res: Response;
  try {
    res = await fetch(`${sttUrl}/transcribe`, {
      method: "POST",
      headers: {
        "Content-Type": "audio/wav",
        ...(env.VOICE_SECRET ? { "X-Voice-Secret": env.VOICE_SECRET } : {}),
      },
      body: new Uint8Array(wav),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    markDown();
    throw new VoiceUnavailable("The speech service could not be reached.");
  }
  if (!res.ok) throw new VoiceUnavailable(`The speech service refused the audio (${res.status}).`);
  const body = (await res.json()) as { text?: string; seconds?: number };
  return { text: (body.text ?? "").trim(), seconds: body.seconds ?? 0 };
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

let up: boolean | null = null;
let checkedAt = 0;

function markDown() {
  up = false;
  checkedAt = Date.now();
}
function markUp() {
  up = true;
  checkedAt = Date.now();
}

/** Whether the voice server answers, checked at most every 30 seconds. */
export async function voiceServiceUp(): Promise<boolean> {
  if (up !== null && Date.now() - checkedAt < 30_000) return up;
  try {
    const res = await fetch(`${baseUrl()}/health`, { signal: AbortSignal.timeout(3000) });
    up = res.ok;
  } catch {
    up = false;
  }
  checkedAt = Date.now();
  return up;
}

/**
 * Makes speech ahead of time and keeps it in the cache, so it plays the
 * moment it is asked for: the live-mode greeting, and the preview clips.
 * Failures are ignored; the real request will simply make it then.
 */
export async function warm(texts: string[], voiceId: string): Promise<void> {
  // Cut exactly as /voice/speak will cut them, so the cached pieces match.
  for (const text of texts) {
    for (const piece of speechPieces(splitSentences(text), true)) {
      try {
        await synthesize(piece.text, voiceId);
      } catch {
        return;
      }
    }
  }
}

/** The first thing said in a live session: short, and made before it is needed. */
export function greetingFor(name: string | null | undefined): string {
  const first = (name ?? "").trim().split(/\s+/)[0]?.replace(/[^\p{L}\p{N}'-]/gu, "") ?? "";
  return first ? `Hello ${first}, what can I do for you today?` : "Hello, what can I do for you today?";
}

/** Wakes the voice server's default voice once it is up, so the first real request is not the slow one. */
export function startVoiceProbe() {
  let tries = 0;
  const probe = async () => {
    tries++;
    if (await voiceServiceUp()) {
      await warm([greetingFor(null), PREVIEW_TEXT(findVoice(DEFAULT_VOICE)?.name ?? "Heart")], DEFAULT_VOICE);
      console.log(`[voice] voice server ready; ${DEFAULT_VOICE} greeting and preview cached`);
      return;
    }
    if (tries < 40) setTimeout(probe, 15_000).unref();
  };
  setTimeout(probe, 2000).unref();
}

// ---------------------------------------------------------------------------
// Rate limit, per user
// ---------------------------------------------------------------------------

/** About half an hour of speech per 10 minutes is far above real use. */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_CHARS_PER_WINDOW = 40_000;
const MAX_REQUESTS_PER_WINDOW = 600;

const usage = new Map<string, { start: number; chars: number; requests: number }>();

/** Null if allowed (and counted), otherwise the reason. */
export function takeVoiceAllowance(userId: string, chars: number, now = Date.now()): string | null {
  let u = usage.get(userId);
  if (!u || now - u.start > WINDOW_MS) {
    u = { start: now, chars: 0, requests: 0 };
    usage.set(userId, u);
  }
  if (u.requests + 1 > MAX_REQUESTS_PER_WINDOW || u.chars + chars > MAX_CHARS_PER_WINDOW) {
    return "You've used a lot of read-aloud in the last few minutes. Wait a moment and try again.";
  }
  u.requests++;
  u.chars += chars;
  return null;
}

/** For tests. */
export function resetVoiceAllowance() {
  usage.clear();
}
