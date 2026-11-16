"use client";

/**
 * Astraeya's voice in the browser.
 *
 * Text goes to the API, which has it spoken on Astraeya's own voice server and
 * streams the audio back a sentence at a time; each sentence plays as soon as
 * it arrives. stop() silences everything at once, which is what lets live mode
 * hand the turn back the moment the person starts talking.
 *
 * If the voice service cannot be reached, whatever is left is spoken with the
 * browser's own voice instead, and onNotice says so.
 */

import { API_BASE_URL } from "../api";
import { authHeaders } from "../api-client";
import { FrameReader } from "./frames";

export interface VoicePlayerOptions {
  /** One of Astraeya's voice ids. */
  voice: string;
  /** 0–1. */
  volume?: number;
  /** Speed and pitch apply only to the browser's backup voice. */
  rate?: number;
  pitch?: number;
  /** Something the person should know, e.g. that the browser's backup voice is reading. */
  onNotice?: (message: string) => void;
  /** Called once when the first sound starts. */
  onStart?: () => void;
  /** Called once when everything queued has been spoken (not after stop()). */
  onEnd?: () => void;
  /**
   * What is being read (a message id). Every speaker button for the same key
   * shows this reading and can pause or continue it, including auto-read.
   */
  key?: string;
}

/** Pause after a piece when the server does not say; a natural breath. */
const DEFAULT_PAUSE = 0.22;
/** Requests in flight at once for one player: the next pieces are made while this one plays. */
const MAX_IN_FLIGHT = 3;

type Playable = { buffer: AudioBuffer; pause: number } | { fallback: string[] };

/** A queue that is filled by a download and read, in order, by playback. */
class Pipe<T> {
  private items: T[] = [];
  private waiting: ((v: IteratorResult<T>) => void) | null = null;
  private closed = false;
  push(item: T) {
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: item, done: false });
    } else this.items.push(item);
  }
  close() {
    this.closed = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: undefined as never, done: true });
    }
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<T>>((r) => (this.waiting = r));
      if (next.done) return;
      yield next.value;
    }
  }
}

let sharedContext: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  if (!sharedContext || sharedContext.state === "closed") sharedContext = new Ctx();
  return sharedContext;
}

/** Call from a click or key press so later playback is allowed to start. */
export function unlockAudio() {
  const ctx = audioContext();
  // A reading the person paused stays paused; only resumeReading() wakes it.
  if (current?.isPaused) return;
  if (ctx?.state === "suspended") void ctx.resume();
  // A silent blip started inside the gesture is what Safari needs to unlock.
  if (ctx) {
    try {
      const b = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = b;
      src.connect(ctx.destination);
      src.start();
    } catch {
      /* nothing to unlock */
    }
  }
}

export class VoicePlayer {
  private ctx = audioContext();
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private nextStart = 0;
  private chain: Promise<void> = Promise.resolve();
  private aborts = new Set<AbortController>();
  private inFlight = 0;
  private waitingToFetch: (() => void)[] = [];
  private sentFirst = false;
  private pending = 0;
  private ended = false;
  private stopped = false;
  private started = false;
  private finished = false;
  private noticed = new Set<string>();
  private usingBrowser = false;
  private paused = false;
  /** Suspend/resume calls, in order, so the last tap always wins. */
  private clock: Promise<unknown> = Promise.resolve();
  private energyData: Uint8Array<ArrayBuffer> | null = null;

  constructor(private opts: VoicePlayerOptions) {
    if (this.ctx) {
      this.gain = this.ctx.createGain();
      this.gain.gain.value = opts.volume ?? 1;
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.gain.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this.energyData = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
    }
  }

  /** Adds text to speak after whatever is already queued. */
  enqueue(text: string) {
    if (this.stopped || this.ended || !text.trim()) return;
    this.pending++;
    const first = !this.sentFirst;
    this.sentFirst = true;
    // The download starts now, alongside the others; playback still goes in order.
    const pipe = new Pipe<Playable>();
    void this.download(text, first, pipe);
    this.chain = this.chain
      .then(() => this.play(pipe))
      .finally(() => {
        this.pending--;
        this.maybeFinish();
      });
  }

  /** No more text is coming; onEnd fires once the queue has been spoken. */
  end() {
    this.ended = true;
    this.maybeFinish();
  }

  /** Silences everything immediately and cancels what has not been made yet. */
  stop() {
    const wasPaused = this.paused;
    this.stopped = true;
    this.paused = false;
    // The context is shared: leave it running for whatever plays next.
    if (wasPaused && this.ctx) {
      const ctx = this.ctx;
      this.clock = this.clock.then(() => (ctx.state === "suspended" ? ctx.resume() : undefined)).catch(() => undefined);
    }
    for (const a of this.aborts) a.abort();
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    if (this.usingBrowser && typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }

  get isStopped() {
    return this.stopped;
  }

  /**
   * Holds the sound exactly where it is. Audio already made waits on the
   * paused clock and pieces still arriving queue behind it, so continuing
   * picks up mid-word with nothing lost.
   */
  pause() {
    if (this.stopped || this.paused) return;
    this.paused = true;
    this.settleClock();
    if (this.usingBrowser && typeof window !== "undefined") window.speechSynthesis?.pause();
  }

  resume() {
    if (this.stopped || !this.paused) return;
    this.paused = false;
    // Called inside the tap, which is what lets a phone browser start sound again.
    if (this.ctx) void this.ctx.resume().catch(() => undefined);
    this.settleClock();
    if (this.usingBrowser && typeof window !== "undefined") window.speechSynthesis?.resume();
  }

  /**
   * suspend() and resume() finish later, not at once; a state check made
   * mid-way would skip the call and leave the sound stuck. Each tap queues
   * its call behind the previous one and the result is re-checked against
   * what the person asked for last.
   */
  private settleClock() {
    const ctx = this.ctx;
    if (!ctx) return;
    this.clock = this.clock
      .then(async () => {
        if (this.stopped) return;
        if (this.paused && ctx.state === "running") await ctx.suspend();
        else if (!this.paused && ctx.state === "suspended") await ctx.resume();
      })
      .catch(() => undefined);
  }

  get isPaused() {
    return this.paused;
  }

  /** Loudness right now, 0–1, for animating the orb in live mode. */
  energy(): number {
    if (!this.analyser || !this.energyData) return 0;
    this.analyser.getByteTimeDomainData(this.energyData);
    let sum = 0;
    for (const v of this.energyData) sum += ((v - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / this.energyData.length) * 4);
  }

  private notice(message: string) {
    if (this.noticed.has(message)) return;
    this.noticed.add(message);
    this.opts.onNotice?.(message);
  }

  private markStarted() {
    if (this.started) return;
    this.started = true;
    this.opts.onStart?.();
  }

  private maybeFinish() {
    if (this.finished || this.stopped || !this.ended || this.pending > 0) return;
    const remaining = this.ctx ? Math.max(0, this.nextStart - this.ctx.currentTime) : 0;
    const finish = () => {
      if (this.finished || this.stopped) return;
      // Paused, or still sound left on the (paused-then-resumed) clock: wait.
      const left = this.ctx ? this.nextStart - this.ctx.currentTime : 0;
      if (this.paused || left > 0.05) {
        setTimeout(finish, this.paused ? 250 : Math.max(50, left * 1000 + 50));
        return;
      }
      if (this.usingBrowser && typeof window !== "undefined" && window.speechSynthesis?.speaking) {
        setTimeout(finish, 200);
        return;
      }
      this.finished = true;
      this.opts.onEnd?.();
    };
    setTimeout(finish, remaining * 1000 + 50);
  }

  private async slot(): Promise<void> {
    if (this.inFlight < MAX_IN_FLIGHT) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((r) => this.waitingToFetch.push(r));
    this.inFlight++;
  }

  private release() {
    this.inFlight--;
    this.waitingToFetch.shift()?.();
  }

  /** Fetches speech for `text` and feeds decoded pieces into `pipe` as they arrive. */
  private async download(text: string, first: boolean, pipe: Pipe<Playable>) {
    if (this.usingBrowser || !this.ctx) {
      pipe.push({ fallback: [text] });
      pipe.close();
      return;
    }
    await this.slot();
    const abort = new AbortController();
    this.aborts.add(abort);
    try {
      if (this.stopped) return;
      const res = await fetch(`${API_BASE_URL}/voice/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await authHeaders()) },
        body: JSON.stringify({ text, voice: this.opts.voice, first }),
        signal: abort.signal,
      });
      if (res.status === 204) return;
      if (res.status === 429) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        this.notice(body.error ?? "Read-aloud is busy. Try again in a moment.");
        return;
      }
      if (!res.ok || !res.body) throw new Error(`voice ${res.status}`);

      const reader = new FrameReader();
      const stream = res.body.getReader();
      for (;;) {
        const { done, value } = await stream.read();
        if (done || this.stopped) break;
        for (const frame of reader.push(value)) {
          if (frame.header.error) {
            pipe.push({ fallback: frame.header.remaining ?? [] });
            return;
          }
          const bytes = frame.audio;
          const buffer = await this.ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
          pipe.push({ buffer, pause: frame.header.pause ?? DEFAULT_PAUSE });
        }
      }
    } catch (err) {
      if (!this.stopped && (err as Error).name !== "AbortError") pipe.push({ fallback: [text] });
    } finally {
      this.aborts.delete(abort);
      this.release();
      pipe.close();
    }
  }

  /** Plays one queued text's pieces, back to back, as they become ready. */
  private async play(pipe: Pipe<Playable>) {
    for await (const item of pipe) {
      if (this.stopped) return;
      if ("fallback" in item) await this.speakWithBrowser(item.fallback);
      else await this.schedule(item.buffer, item.pause);
    }
  }

  private async schedule(buffer: AudioBuffer, pause: number) {
    if (!this.ctx || !this.gain || this.stopped) return;
    // A piece arriving while paused queues on the held clock; it must not
    // wake the sound up.
    if (this.ctx.state === "suspended" && !this.paused) await this.ctx.resume().catch(() => undefined);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    const at = Math.max(this.ctx.currentTime + 0.02, this.nextStart);
    source.start(at);
    this.nextStart = at + buffer.duration + pause;
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
    setTimeout(() => this.markStarted(), Math.max(0, (at - this.ctx.currentTime) * 1000));
  }

  /** The backup: the browser's own voice, after anything already playing. */
  private async speakWithBrowser(sentences: string[]) {
    const text = sentences.join(" ").trim();
    if (!text || this.stopped) return;
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    if (!this.usingBrowser) {
      this.usingBrowser = true;
      this.notice("Astraeya's voice isn't available right now, so your browser's voice is reading instead.");
    }
    // Let what is already scheduled finish first.
    const wait = this.ctx ? Math.max(0, this.nextStart - this.ctx.currentTime) : 0;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait * 1000));
    if (this.stopped) return;
    await new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = this.opts.rate ?? 1;
      u.pitch = this.opts.pitch ?? 1;
      u.volume = this.opts.volume ?? 1;
      u.onstart = () => this.markStarted();
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    });
  }
}

// ---------------------------------------------------------------------------
// Read-aloud: one at a time across the whole app
// ---------------------------------------------------------------------------

let current: VoicePlayer | null = null;
/** The interrupted reading's onEnd, so its button returns to "Read aloud". */
let currentOnEnd: (() => void) | undefined;

/** What is being read right now, for every speaker button to show. */
export interface ReadingState {
  key: string | null;
  paused: boolean;
}
let reading: ReadingState = { key: null, paused: false };
const readingListeners = new Set<() => void>();

function setReading(next: ReadingState) {
  if (next.key === reading.key && next.paused === reading.paused) return;
  reading = next;
  for (const l of readingListeners) l();
}

export function subscribeReading(listener: () => void): () => void {
  readingListeners.add(listener);
  return () => readingListeners.delete(listener);
}

export function getReading(): ReadingState {
  return reading;
}

/** A reply's id changes when it is saved; the reading follows it. */
export function renameReadingKey(from: string, to: string) {
  if (reading.key === from) setReading({ ...reading, key: to });
}

export function pauseReading() {
  if (!current || current.isStopped) return;
  current.pause();
  setReading({ ...reading, paused: true });
}

export function resumeReading() {
  if (!current || current.isStopped) return;
  unlockAudio();
  current.resume();
  setReading({ ...reading, paused: false });
}

/**
 * The speaker button: pauses or continues what this key is reading, or,
 * if it is not the one being read, starts it (stopping anything else).
 */
export function toggleReading(key: string, start: () => void) {
  if (reading.key === key && current && !current.isStopped) {
    if (reading.paused) resumeReading();
    else pauseReading();
    return;
  }
  start();
}

/**
 * A player whose ending puts the shared state back to idle, checked by which
 * player it is rather than by key (a reply's key changes when it is saved).
 */
function trackedPlayer(opts: VoicePlayerOptions): VoicePlayer {
  const player: VoicePlayer = new VoicePlayer({
    onNotice: announceVoiceNotice,
    ...opts,
    onEnd: () => {
      if (current === player) {
        current = null;
        currentOnEnd = undefined;
        setReading({ key: null, paused: false });
      }
      opts.onEnd?.();
    },
  });
  return player;
}

/** Shown by <VoiceNotice/>, wherever read-aloud was started from. */
export const VOICE_NOTICE_EVENT = "astraeya:voice-notice";

export function announceVoiceNotice(message: string) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(VOICE_NOTICE_EVENT, { detail: message }));
}

/** Reads text aloud, stopping anything already being read. */
export function readAloud(text: string, opts: VoicePlayerOptions): VoicePlayer {
  stopReading();
  unlockAudio();
  const player = trackedPlayer(opts);
  current = player;
  currentOnEnd = opts.onEnd;
  setReading({ key: opts.key ?? null, paused: false });
  player.enqueue(text);
  player.end();
  return player;
}

/**
 * Reads a reply aloud while it is still being written: the caller enqueues
 * each sentence as it completes and calls end() when the reply is done.
 */
export function startReading(opts: VoicePlayerOptions): VoicePlayer {
  stopReading();
  const player = trackedPlayer(opts);
  current = player;
  currentOnEnd = opts.onEnd;
  setReading({ key: opts.key ?? null, paused: false });
  return player;
}

export function stopReading() {
  current?.stop();
  current = null;
  setReading({ key: null, paused: false });
  const done = currentOnEnd;
  currentOnEnd = undefined;
  done?.();
}

// ---------------------------------------------------------------------------
// The voice list
// ---------------------------------------------------------------------------

export interface AstraeyaVoice {
  id: string;
  name: string;
  gender: "female" | "male";
  accent: string;
  engine: string;
  label: string;
  grade?: string;
  credit?: boolean;
}

export interface VoiceList {
  default: string;
  available: boolean;
  /** Speech is made by the hosted provider (DeepInfra), not only our server. */
  hosted?: boolean;
  /** Astra Assist's recordings are turned into text by a provider (Groq or DeepInfra). */
  hostedListening?: boolean;
  voices: AstraeyaVoice[];
}

let voiceList: Promise<VoiceList> | null = null;

export function loadVoices(): Promise<VoiceList> {
  voiceList ??= (async () => {
    const res = await fetch(`${API_BASE_URL}/voice/voices`, { headers: await authHeaders() });
    if (!res.ok) throw new Error("Could not load voices");
    return (await res.json()) as VoiceList;
  })().catch((err) => {
    voiceList = null;
    throw err;
  });
  return voiceList;
}

/** Female first, then male, each in the catalogue's order (best first). */
export function groupVoices(voices: AstraeyaVoice[]): { label: string; voices: AstraeyaVoice[] }[] {
  return [
    { label: "Female", voices: voices.filter((v) => v.gender === "female") },
    { label: "Male", voices: voices.filter((v) => v.gender === "male") },
  ];
}

// ---------------------------------------------------------------------------
// Previews: fetched once per voice and kept for the session
// ---------------------------------------------------------------------------

const previews = new Map<string, Promise<AudioBuffer>>();
let previewSource: AudioBufferSourceNode | null = null;

export async function playPreview(voiceId: string, volume = 1): Promise<void> {
  const ctx = audioContext();
  if (!ctx) throw new Error("This browser cannot play audio.");
  unlockAudio();
  stopReading();
  let clip = previews.get(voiceId);
  if (!clip) {
    clip = (async () => {
      const res = await fetch(`${API_BASE_URL}/voice/preview/${encodeURIComponent(voiceId)}`, { headers: await authHeaders() });
      if (!res.ok) throw new Error("The voice service is not available right now.");
      return ctx.decodeAudioData(await res.arrayBuffer());
    })();
    previews.set(voiceId, clip);
    clip.catch(() => previews.delete(voiceId));
  }
  const buffer = await clip;
  try {
    previewSource?.stop();
  } catch {
    /* already stopped */
  }
  const gain = ctx.createGain();
  gain.gain.value = volume;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(gain).connect(ctx.destination);
  source.start();
  previewSource = source;
  await new Promise<void>((r) => (source.onended = () => r()));
}
