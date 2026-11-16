"use client";

// Astraeya — speech recognition and small audio cues, in the browser.
//
// Listening (speech to text) runs in the browser. Speaking is not here: it is
// Astraeya's own voice server, through lib/voice/tts.ts, which falls back to
// the browser's voice only when that server cannot be reached.

import { useEffect, useState } from "react";
import type { UserSettings } from "./settings/types";

type VoiceSettings = UserSettings["voice"];

export function sttSupported(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
}

/** The SpeechRecognition constructor, whatever this browser calls it. */
export function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as
    | (new () => SpeechRecognitionLike)
    | null;
}

/**
 * The bits of SpeechRecognition this app uses.
 *
 * Typed here rather than pulled from lib.dom: the interface is still
 * vendor-prefixed in most browsers and is not in TypeScript's DOM types.
 */
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  /** Recent Chrome and Edge accept an audio track: the microphone to listen with. */
  start(track?: MediaStreamTrack): void;
  stop(): void;
  abort(): void;
  onresult:
    | ((event: {
        resultIndex: number;
        results: {
          length: number;
          [index: number]: { isFinal: boolean; 0: { transcript: string } };
        };
      }) => void)
    | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
}

/**
 * What this browser can do: speech recognition for listening, and Web Audio
 * for playing Astraeya's voice. Checked after mount, since neither exists
 * during server rendering.
 */
export function useSpeechSupport() {
  const [supported, setSupported] = useState({ tts: false, stt: false });
  useEffect(() => {
    setSupported({
      tts: typeof window !== "undefined" && ("AudioContext" in window || "webkitAudioContext" in window),
      stt: sttSupported(),
    });
  }, []);
  return { ttsSupported: supported.tts, sttSupported: supported.stt };
}

/** The recognition language, honouring "detect automatically". */
export function recognitionLanguage(settings: VoiceSettings): string {
  if (settings.autoDetectInputLanguage && typeof navigator !== "undefined") {
    return navigator.language || settings.inputLanguage;
  }
  return settings.inputLanguage;
}

/**
 * A short tone, when sound effects are on.
 *
 * Synthesised with the Web Audio API rather than shipped as an asset — it is
 * two oscillator envelopes, and an audio file would be a network request for
 * something the browser can make.
 */
export function playCue(kind: "start" | "stop", settings: VoiceSettings): void {
  if (!settings.soundEffects || typeof window === "undefined") return;

  const AudioCtx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioCtx) return;

  try {
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.value = kind === "start" ? 660 : 440;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.16);

    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.18);
    // Closing releases the audio hardware; leaving contexts open exhausts the
    // browser's limit after a few dozen cues.
    osc.onended = () => void ctx.close();
  } catch {
    // Autoplay policy, or no audio device. A missing beep is not an error.
  }
}

/** A brief vibration, on devices that have one. */
export function haptic(settings: { hapticFeedback: boolean }, ms = 15): void {
  if (!settings.hapticFeedback) return;
  if (typeof navigator === "undefined" || !("vibrate" in navigator)) return;
  try {
    navigator.vibrate(ms);
  } catch {
    // Blocked by the browser. Nothing to report.
  }
}
