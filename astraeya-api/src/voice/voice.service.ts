/**
 * Talking to the voice server (astraeya-voice), which turns one sentence and
 * a voice id into a WAV. Everything user-facing goes through here:
 *
 * - an unknown voice id becomes af_heart, before anything is asked for
 * - identical sentences in the same voice are made once and then served
 *   from memory, and so are the preview clips
 * - the time each engine takes is tracked, so live mode can switch to a fast
 *   voice when the chosen one would leave the person waiting
 */

import { createHash } from "node:crypto";
import { env } from "../env";
import { DEFAULT_VOICE, FAST_VOICE, findVoice, normalizeVoiceId } from "./catalogue";

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
// Speed tracking
// ---------------------------------------------------------------------------

/** Above this wait for the first sentence, live mode uses a fast voice. */
export const LIVE_FIRST_AUDIO_LIMIT_MS = 1500;
/** Roughly how long the first sentence of a reply takes to say. */
const TYPICAL_FIRST_SENTENCE_SECONDS = 2.5;

type SpeedClass = "kokoro" | "piper" | "piper-high";

/** Milliseconds of work per second of audio, smoothed. Unknown until measured. */
const msPerAudioSecond = new Map<SpeedClass, number>();

function speedClass(voiceId: string): SpeedClass {
  const v = findVoice(voiceId);
  if (v?.engine === "kokoro") return "kokoro";
  return voiceId.endsWith("-high") ? "piper-high" : "piper";
}

export function recordSpeed(voiceId: string, synthMs: number, audioSeconds: number) {
  if (!(audioSeconds > 0.3) || !(synthMs >= 0)) return;
  const cls = speedClass(voiceId);
  const sample = synthMs / audioSeconds;
  const prev = msPerAudioSecond.get(cls);
  msPerAudioSecond.set(cls, prev === undefined ? sample : prev * 0.7 + sample * 0.3);
}

export function estimatedFirstAudioMs(voiceId: string): number | null {
  const rate = msPerAudioSecond.get(speedClass(voiceId));
  return rate === undefined ? null : rate * TYPICAL_FIRST_SENTENCE_SECONDS;
}

/**
 * The voice live mode should use: the chosen one, or a fast voice of the same
 * gender when the chosen one is measured too slow to start within 1.5 s.
 */
export function liveVoiceFor(voiceId: string): { voice: string; substituted: boolean } {
  const chosen = normalizeVoiceId(voiceId);
  const estimate = estimatedFirstAudioMs(chosen);
  if (estimate === null || estimate <= LIVE_FIRST_AUDIO_LIMIT_MS) return { voice: chosen, substituted: false };
  const fast = FAST_VOICE[findVoice(chosen)?.gender ?? "female"];
  if (fast === chosen) return { voice: chosen, substituted: false };
  return { voice: fast, substituted: true };
}

/** For tests. */
export function resetSpeeds() {
  msPerAudioSecond.clear();
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

/** One sentence in one voice, from the cache if it has been made before. */
export async function synthesize(text: string, voiceId: string, signal?: AbortSignal): Promise<Speech> {
  const voice = normalizeVoiceId(voiceId);
  const key = cacheKey(voice, text);
  const hit = cacheGet(key);
  if (hit) return { ...hit, cached: true };

  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/synthesize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.VOICE_SECRET ? { "X-Voice-Secret": env.VOICE_SECRET } : {}),
      },
      body: JSON.stringify({ text, voice }),
      signal: signal ?? AbortSignal.timeout(60_000),
    });
  } catch (err) {
    if ((err as Error).name === "AbortError" && signal?.aborted) throw err;
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
  recordSpeed(voice, Number(res.headers.get("x-synth-ms") ?? NaN), seconds);
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
 * Measures the default voice once the server is up, so the first live session
 * already knows whether it needs the fast voice. Retries quietly until the
 * voice server has finished loading.
 */
export function startVoiceProbe() {
  let tries = 0;
  const probe = async () => {
    tries++;
    try {
      if (await voiceServiceUp()) {
        // Not through the cache: this must measure the engine.
        const t = performance.now();
        const res = await fetch(`${baseUrl()}/synthesize`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(env.VOICE_SECRET ? { "X-Voice-Secret": env.VOICE_SECRET } : {}) },
          body: JSON.stringify({ text: "Hello, how can I help you today?", voice: DEFAULT_VOICE }),
          signal: AbortSignal.timeout(60_000),
        });
        if (res.ok) {
          await res.arrayBuffer();
          const seconds = Number(res.headers.get("x-audio-seconds") ?? 0);
          recordSpeed(DEFAULT_VOICE, Number(res.headers.get("x-synth-ms") ?? performance.now() - t), seconds);
          const est = estimatedFirstAudioMs(DEFAULT_VOICE);
          console.log(
            `[voice] ${DEFAULT_VOICE}: about ${Math.round(est ?? 0)} ms to first audio${
              (est ?? 0) > LIVE_FIRST_AUDIO_LIMIT_MS ? "; live mode will use the fast voices" : ""
            }`
          );
          return;
        }
      }
    } catch {
      /* try again below */
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
