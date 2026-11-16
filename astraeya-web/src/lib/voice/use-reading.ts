"use client";

import { useSyncExternalStore } from "react";
import { getReading, subscribeReading, type ReadingState } from "./tts";

const idle: ReadingState = { key: null, paused: false };

/** Whether `key` is being read aloud right now, and whether it is paused. */
export function useReading(key: string | undefined): { active: boolean; paused: boolean } {
  const state = useSyncExternalStore(subscribeReading, getReading, () => idle);
  const active = Boolean(key) && state.key === key;
  return { active, paused: active && state.paused };
}
