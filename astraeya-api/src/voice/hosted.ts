/**
 * Hosted speech (DeepInfra): the same Kokoro model, so exactly the same Heart
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
let pausedUntil = 0;
function noteFailure(status?: number): void {
  pausedUntil = Date.now() + (status === 401 || status === 402 || status === 403 ? 5 * 60_000 : 30_000);
}

/** Switched on, and not paused after a recent failure. */
export function hostedSpeechReady(): boolean {
  return hostedSpeechEnabled() && Date.now() >= pausedUntil;
}

/** For tests. */
export function resetHostedPause(): void {
  pausedUntil = 0;
}

async function call(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${BASE()}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    noteFailure();
    throw err;
  }
  if (!res.ok) {
    noteFailure(res.status);
    throw new Error(`hosted ${path} ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
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
    "/audio/speech",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.DEEPINFRA_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "hexgrad/Kokoro-82M", input: text, voice, response_format: "wav", speed: 1.0 }),
    },
    8_000,
  );
  const wav = Buffer.from(await res.arrayBuffer());
  if (wavSeconds(wav) <= 0) {
    noteFailure();
    throw new Error("hosted speech returned no audio");
  }
  return wav;
}

/** The words in a WAV recording, from hosted Whisper. */
export async function hostedTranscribe(wav: Buffer): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");
  form.append("model", "openai/whisper-large-v3-turbo");
  form.append("language", "en");
  const res = await call("/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${env.DEEPINFRA_API_KEY}` }, body: form }, 10_000);
  const body = (await res.json()) as { text?: string };
  return (body.text ?? "").trim();
}
