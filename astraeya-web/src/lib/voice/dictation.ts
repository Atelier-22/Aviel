// Astraeya — how long dictation keeps listening.
//
// Browsers end a speech-recognition session on their own: after a pause,
// after about a minute, or on a network hiccup. To the person dictating that
// looks like the microphone giving up mid-sentence. So a dictation session is
// ours, not the browser's: when the browser ends one, we start the next,
// until the person taps stop or the time limit is reached.

/** The longest a single dictation can run: 20 minutes. */
export const MAX_DICTATION_MS = 20 * 60 * 1000;

/**
 * Errors that mean the microphone can't be used at all. Restarting would only
 * fail again, or keep asking for a permission the person already refused.
 */
const FATAL_ERRORS = new Set([
  "not-allowed",
  "service-not-allowed",
  "audio-capture",
  "language-not-supported",
]);

export function isFatalDictationError(error: string | null | undefined): boolean {
  return Boolean(error && FATAL_ERRORS.has(error));
}

/** Whether to start listening again after the browser ended a session. */
export function shouldRestartDictation(opts: {
  /** The person still wants to dictate (has not tapped stop). */
  wanted: boolean;
  startedAt: number;
  now: number;
  lastError?: string | null;
  /** Restarts in a row that heard nothing before ending. */
  quickFailures?: number;
}): boolean {
  if (!opts.wanted) return false;
  if (isFatalDictationError(opts.lastError)) return false;
  if (opts.now - opts.startedAt >= MAX_DICTATION_MS) return false;
  // A browser that ends every session instantly (offline, no speech service)
  // would otherwise spin in a tight loop.
  if ((opts.quickFailures ?? 0) >= 5) return false;
  return true;
}
