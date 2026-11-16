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
  const res = await fetch(`${BASE()}/audio/speech`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.DEEPINFRA_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "hexgrad/Kokoro-82M", input: text, voice, response_format: "wav", speed: 1.0 }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`hosted speech ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const wav = Buffer.from(await res.arrayBuffer());
  if (wavSeconds(wav) <= 0) throw new Error("hosted speech returned no audio");
  return wav;
}

/** The words in a WAV recording, from hosted Whisper. */
export async function hostedTranscribe(wav: Buffer): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");
  form.append("model", "openai/whisper-large-v3-turbo");
  form.append("language", "en");
  const res = await fetch(`${BASE()}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.DEEPINFRA_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`hosted transcription ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const body = (await res.json()) as { text?: string };
  return (body.text ?? "").trim();
}
