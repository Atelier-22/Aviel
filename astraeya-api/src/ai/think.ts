// Astraeya — think modes.
//
// "Fast", "Balanced" and "Deep think" are the effort of whichever model the
// person chose (Athena 2.5, Metis 3.0 or Lotus). They never swap the model:
// they set how hard it thinks, how much room it gets, and how much working it
// shows.
//
// The honest part is what happens when a model has no reasoning tier. Nothing
// here pretends: the mode still applies at the prompt level, and
// `describeThinkMode` reports exactly what the user will actually get so the
// composer can say it rather than implying extended reasoning that is not
// happening.

import type { UserSettings } from "../settings/schema";
import { availableModels, providerForModel } from "./index";

export type ThinkMode = "fast" | "balanced" | "deep";

export interface ThinkResolution {
  mode: ThinkMode;
  /** The model this mode wants, or null to leave the choice alone. */
  model: string | null;
  /** Ceiling for this turn, before the platform clamp. */
  maxTokens: number | null;
  /** Appended to the system prompt. Empty for balanced, which is the baseline. */
  instruction: string;
  /**
   * Whether a model with a genuine reasoning tier is answering. False on deep
   * means the instruction below is doing the work instead — which is worth
   * saying out loud rather than letting the label imply otherwise.
   */
  nativeReasoning: boolean;
  /** One sentence for the UI, describing what this mode will actually do. */
  note: string;
}

const FAST_INSTRUCTION = `\n\nAnswer directly and briefly. Lead with the answer, skip preamble and caveats unless they change what the user should do, and do not show working.`;

const DEEP_INSTRUCTION = `\n\nThis question deserves care. Work through it before answering: consider the cases, name the assumptions you are making, and say where you are uncertain. Give a short summary of your reasoning, then the conclusion. Do not pad — depth means considering more, not writing more.`;

const FAST_TOKENS = 2048;
const DEEP_TOKENS = 16000;

/**
 * Which model, ceiling and instruction a mode implies for this account.
 *
 * `requested` is the per-message override from the composer; without one the
 * account's standing preference applies.
 */
export function resolveThinkMode(
  settings: UserSettings,
  requested?: ThinkMode
): ThinkResolution {
  const mode = requested ?? settings.ai.thinkMode;
  const available = new Set(availableModels().map((m) => m.value));

  const pick = (candidate: string | null): string | null =>
    candidate && available.has(candidate) ? candidate : null;

  if (mode === "fast") {
    return {
      mode,
      model: null,
      maxTokens: FAST_TOKENS,
      instruction: FAST_INSTRUCTION,
      nativeReasoning: false,
      note: "Quick, short answers with little thinking.",
    };
  }

  if (mode === "deep") {
    const model = pick(settings.ai.defaultModel);
    const native = model ? providerForModel(model).capabilities.reasoning : false;
    return {
      mode,
      model: null,
      maxTokens: DEEP_TOKENS,
      instruction: DEEP_INSTRUCTION,
      nativeReasoning: native,
      note: "Thinks hardest before answering. Slower, and uses more of the model's power.",
    };
  }

  return {
    mode: "balanced",
    model: null,
    maxTokens: null,
    instruction: "",
    nativeReasoning: false,
    note: "The usual balance of speed and care.",
  };
}

/**
 * What each mode would do for this account, for the composer's menu.
 *
 * Computed rather than hardcoded so the menu describes this server and this
 * account — a machine with no reasoning model says so on the Deep entry
 * instead of promising something it cannot do.
 */
export function describeThinkModes(settings: UserSettings): {
  mode: ThinkMode;
  label: string;
  note: string;
  nativeReasoning: boolean;
}[] {
  return (["fast", "balanced", "deep"] as const).map((mode) => {
    const resolved = resolveThinkMode(settings, mode);
    return {
      mode,
      label: mode === "fast" ? "Fast" : mode === "deep" ? "Deep think" : "Balanced",
      note: resolved.note,
      nativeReasoning: resolved.nativeReasoning,
    };
  });
}
