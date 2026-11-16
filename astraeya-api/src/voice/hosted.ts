/**
 * Hosted speech (DeepInfra) and listening (Groq or DeepInfra): the same Kokoro model, so exactly the same Heart
 * voice, and Whisper for listening, running on GPUs. Used when
 * DEEPINFRA_API_KEY is set, because it answers in a fraction of a second
 * where this laptop's CPU takes seconds. Any failure falls back to Astraeya's
 * own voice server, so speech never stops because of it.
 *
 * Reply text and recordings go to DeepInfra to be processed. The privacy
 * wording in the apps says so while this is switched on.
 */

import { env } from "../env";

const BASE = () => (env.DEEPINFRA_BASE_URL ?? "https://api.deepinfra.com/v1/openai").replace(/\/$/, "");

export function hostedSpeechEnabled(): boolean {
  return Boolean(env.DEEPINFRA_API_KEY);
}

/**
 * After a failure the provider is skipped for a while, so replies don't each
 * wait seconds for a refusal before our own server speaks. No credit or a bad
 * key (402, 401, 403) pauses it for 5 minutes; anything else for 30 seconds.
 */
const pausedUntil = new Map<string, number>();
function noteFailure(provider: string, status?: number): void {
  pausedUntil.set(provider, Date.now() + (status === 401 || status === 402 || status === 403 ? 5 * 60_000 : status === 429 ? 60_000 : 30_000));
}
function paused(provider: string): boolean {
  return Date.now() < (pausedUntil.get(provider) ?? 0);
}

/** Switched on, and not paused after a recent failure. */
export function hostedSpeechReady(): boolean {
  return hostedSpeechEnabled() && !paused("deepinfra");
}

/**
 * Listening: Groq's Whisper (free plan: 2,000 requests a day) when GROQ_API_KEY
 * is set, else DeepInfra's when its key is set.
 */
function listener(): { name: string; base: string; key: string; model: string } | null {
  if (env.GROQ_API_KEY && !paused("groq")) return { name: "groq", base: "https://api.groq.com/openai/v1", key: env.GROQ_API_KEY, model: "whisper-large-v3-turbo" };
  if (env.DEEPINFRA_API_KEY && !paused("deepinfra")) return { name: "deepinfra", base: BASE(), key: env.DEEPINFRA_API_KEY, model: "openai/whisper-large-v3-turbo" };
  return null;
}

export function hostedListeningReady(): boolean {
  return listener() !== null;
}

/** Recordings may go to a provider (shown in the privacy text). */
export function hostedListeningEnabled(): boolean {
  return Boolean(env.GROQ_API_KEY || env.DEEPINFRA_API_KEY);
}

/** For tests. */
export function resetHostedPause(): void {
  pausedUntil.clear();
}

async function call(provider: string, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    noteFailure(provider);
    throw err;
  }
  if (!res.ok) {
    noteFailure(provider, res.status);
    throw new Error(`${provider} ${new URL(url).pathname} ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
  return res;
}

/** Seconds of audio in a PCM WAV, read from its header. */
export function wavSeconds(wav: Buffer): number {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF") return 0;
  const byteRate = wav.readUInt32LE(28);
  // Find the "data" chunk rather than assuming it is at byte 36.
  let o = 12;
  while (o + 8 <= wav.length) {
    const id = wav.toString("ascii", o, o + 4);
    const size = wav.readUInt32LE(o + 4);
    if (id === "data") return byteRate ? Math.min(size, wav.length - o - 8) / byteRate : 0;
    o += 8 + size;
  }
  return 0;
}

/** Heart (or any Kokoro voice) from the hosted Kokoro model, as WAV. */
export async function hostedSpeak(text: string, voice: string): Promise<Buffer> {
  const res = await call(
    "deepinfra",
    `${BASE()}/audio/speech`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.DEEPINFRA_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "hexgrad/Kokoro-82M", input: text, voice, response_format: "wav", speed: 1.0 }),
    },
    8_000,
  );
  const wav = Buffer.from(await res.arrayBuffer());
  if (wavSeconds(wav) <= 0) {
    noteFailure("deepinfra");
    throw new Error("hosted speech returned no audio");
  }
  return wav;
}

/** The words in a WAV recording, from hosted Whisper. */
export async function hostedTranscribe(wav: Buffer): Promise<string> {
  const who = listener();
  if (!who) throw new Error("no hosted listening");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");
  form.append("model", who.model);
  form.append("language", "en");
  const res = await call(who.name, `${who.base}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${who.key}` }, body: form }, 10_000);
  const body = (await res.json()) as { text?: string };
  return (body.text ?? "").trim();
}
