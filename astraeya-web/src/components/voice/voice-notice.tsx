"use client";

import { useEffect, useState } from "react";
import { Volume2 } from "lucide-react";
import { VOICE_NOTICE_EVENT } from "@/lib/voice/tts";

/**
 * A small, temporary note about read-aloud: the browser's backup voice is
 * reading because Astraeya's voice server is down, or read-aloud is busy.
 */
export function VoiceNotice() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = (e: Event) => {
      setMessage((e as CustomEvent<string>).detail);
      clearTimeout(timer);
      timer = setTimeout(() => setMessage(null), 7000);
    };
    window.addEventListener(VOICE_NOTICE_EVENT, show);
    return () => {
      window.removeEventListener(VOICE_NOTICE_EVENT, show);
      clearTimeout(timer);
    };
  }, []);

  if (!message) return null;
  return (
    <div
      role="status"
      className="fixed bottom-24 left-1/2 z-50 flex max-w-[90vw] -translate-x-1/2 items-center gap-2 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-4 py-2 text-sm text-[var(--text-secondary)] shadow-lg"
    >
      <Volume2 size={14} className="shrink-0" />
      {message}
    </div>
  );
}
