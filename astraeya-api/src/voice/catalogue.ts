/**
 * The voices Astraeya speaks with. A copy of astraeya-voice/voices.json (the
 * source of truth), kept here so the voice picker works and unknown ids can be
 * corrected even while the voice server is down. voices.test.ts fails if the
 * two drift apart.
 */

export type VoiceGender = "female" | "male";

export interface VoiceInfo {
  id: string;
  name: string;
  gender: VoiceGender;
  accent: string;
  engine: "kokoro" | "piper";
  /** The Kokoro authors' quality grade, A best. Piper voices have none. */
  grade?: string;
  /** Audio published elsewhere needs the CC BY 4.0 credit line. */
  credit?: boolean;
}

export const DEFAULT_VOICE = "af_heart";

export const VOICES: VoiceInfo[] = [
  { id: "af_heart", name: "Heart", gender: "female", accent: "American", engine: "kokoro", grade: "A" },
  { id: "af_bella", name: "Bella", gender: "female", accent: "American", engine: "kokoro", grade: "A-" },
  { id: "af_nicole", name: "Nicole", gender: "female", accent: "American", engine: "kokoro", grade: "B-" },
  { id: "af_aoede", name: "Aoede", gender: "female", accent: "American", engine: "kokoro", grade: "C+" },
  { id: "af_kore", name: "Kore", gender: "female", accent: "American", engine: "kokoro", grade: "C+" },
  { id: "af_sarah", name: "Sarah", gender: "female", accent: "American", engine: "kokoro", grade: "C+" },
  { id: "af_nova", name: "Nova", gender: "female", accent: "American", engine: "kokoro", grade: "C" },
  { id: "af_alloy", name: "Alloy", gender: "female", accent: "American", engine: "kokoro", grade: "C" },
  { id: "af_sky", name: "Sky", gender: "female", accent: "American", engine: "kokoro", grade: "C-" },
  { id: "af_jessica", name: "Jessica", gender: "female", accent: "American", engine: "kokoro", grade: "D" },
  { id: "af_river", name: "River", gender: "female", accent: "American", engine: "kokoro", grade: "D" },
  { id: "bf_emma", name: "Emma", gender: "female", accent: "British", engine: "kokoro", grade: "B-" },
  { id: "bf_isabella", name: "Isabella", gender: "female", accent: "British", engine: "kokoro", grade: "C" },
  { id: "bf_alice", name: "Alice", gender: "female", accent: "British", engine: "kokoro", grade: "D" },
  { id: "bf_lily", name: "Lily", gender: "female", accent: "British", engine: "kokoro", grade: "D" },
  { id: "am_michael", name: "Michael", gender: "male", accent: "American", engine: "kokoro", grade: "C+" },
  { id: "am_fenrir", name: "Fenrir", gender: "male", accent: "American", engine: "kokoro", grade: "C+" },
  { id: "am_puck", name: "Puck", gender: "male", accent: "American", engine: "kokoro", grade: "C+" },
  { id: "am_liam", name: "Liam", gender: "male", accent: "American", engine: "kokoro", grade: "D" },
  { id: "am_echo", name: "Echo", gender: "male", accent: "American", engine: "kokoro", grade: "D" },
  { id: "am_eric", name: "Eric", gender: "male", accent: "American", engine: "kokoro", grade: "D" },
  { id: "am_onyx", name: "Onyx", gender: "male", accent: "American", engine: "kokoro", grade: "D" },
  { id: "am_adam", name: "Adam", gender: "male", accent: "American", engine: "kokoro", grade: "F+" },
  { id: "bm_george", name: "George", gender: "male", accent: "British", engine: "kokoro", grade: "C" },
  { id: "bm_fable", name: "Fable", gender: "male", accent: "British", engine: "kokoro", grade: "C" },
  { id: "bm_lewis", name: "Lewis", gender: "male", accent: "British", engine: "kokoro", grade: "D+" },
  { id: "bm_daniel", name: "Daniel", gender: "male", accent: "British", engine: "kokoro", grade: "D" },
  { id: "en_GB-cori-high", name: "Cori", gender: "female", accent: "British", engine: "piper" },
  { id: "en_GB-cori-medium", name: "Cori (Light)", gender: "female", accent: "British", engine: "piper", credit: true },
  { id: "en_US-kristin-medium", name: "Kristin", gender: "female", accent: "American", engine: "piper" },
  { id: "en_US-kathleen-medium", name: "Kathleen", gender: "female", accent: "American", engine: "piper", credit: true },
  { id: "en_US-ljspeech-high", name: "Linda", gender: "female", accent: "American", engine: "piper" },
  { id: "en_US-john-medium", name: "John", gender: "male", accent: "American", engine: "piper" },
  { id: "en_US-joe-medium", name: "Joe", gender: "male", accent: "American", engine: "piper" },
  { id: "en_US-norman-medium", name: "Norman", gender: "male", accent: "American", engine: "piper" },
];

const BY_ID = new Map(VOICES.map((v) => [v.id, v]));

export function findVoice(id: string | null | undefined): VoiceInfo | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/** Any stored or requested voice id, made valid: unknown, old browser voice names and null all become the default. */
export function normalizeVoiceId(id: unknown): string {
  return typeof id === "string" && BY_ID.has(id) ? id : DEFAULT_VOICE;
}

/** "Heart (Female, American)". */
export function voiceLabel(v: VoiceInfo): string {
  return `${v.name} (${v.gender === "female" ? "Female" : "Male"}, ${v.accent})`;
}
