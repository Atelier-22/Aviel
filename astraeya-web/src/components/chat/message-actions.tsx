"use client";

import { useEffect, useState } from "react";
import {
  Copy,
  Check,
  ThumbsUp,
  ThumbsDown,
  Share2,
  RotateCcw,
  Volume2,
  Pause,
  Play,
  GitBranch,
  Download,
  FileText,
  FileCode,
} from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { downloadMarkdown, downloadWord } from "@/lib/export-reply";
import { useSettingsGroup } from "@/lib/settings/store";
import { readAloud, toggleReading } from "@/lib/voice/tts";
import { useReading } from "@/lib/voice/use-reading";

type Feedback = "up" | "down" | null;

export function MessageActions({
  content,
  onRetry,
  onBranch,
  messageId,
  conversationId,
  variant = "assistant",
}: {
  content: string;
  onRetry?: () => void;
  /** Start a new chat from this point. Absent when the message can't be branched yet. */
  onBranch?: () => void;
  messageId?: string;
  conversationId?: string;
  /** Your own messages get copy and branch only; replies get the full set. */
  variant?: "assistant" | "user";
}) {
  const voice = useSettingsGroup("voice");
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  // The same reading is shown on this button whether it was started here or
  // by "Read every reply aloud": tap to pause, tap again to carry on.
  const readingKey = messageId ?? `reply:${content.length}:${content.slice(0, 48)}`;
  const reading = useReading(readingKey);
  // Astraeya's voices play through Web Audio, which every current browser has.
  const [ttsSupported, setTtsSupported] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);

  useEffect(() => {
    setTtsSupported(typeof window !== "undefined" && ("AudioContext" in window || "webkitAudioContext" in window));
  }, []);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable, ignore
    }
  }

  async function handleFeedback(value: "up" | "down") {
    const next = feedback === value ? null : value;
    setFeedback(next);
    if (!next || !messageId) return;
    try {
      await apiFetch("/feedback", {
        method: "POST",
        body: JSON.stringify({ messageId, conversationId, rating: next }),
      });
    } catch {
      // best-effort — feedback UI already reflects the choice locally
    }
  }

  async function handleShare() {
    if (navigator.share) {
      try {
        await navigator.share({ text: content });
      } catch {
        // user cancelled the share sheet — no error needed
      }
    } else {
      await handleCopy();
    }
  }

  function handleReadAloud() {
    if (!ttsSupported) return;
    // Voice, speed, pitch and volume all come from the account's settings, so
    // Read Aloud sounds the same here as the preview in Settings does.
    toggleReading(readingKey, () =>
      readAloud(content, {
        key: readingKey,
        voice: voice.outputVoice,
        volume: voice.volume,
        rate: voice.rate,
        pitch: voice.pitch,
      })
    );
  }

  const btn =
    "flex items-center gap-1 rounded-md p-1.5 text-[var(--text-secondary)] hover:bg-black/5 hover:text-[var(--text-primary)] dark:hover:bg-white/10";

  const copyButton = (
    <button
      onClick={handleCopy}
      title={copied ? "Copied" : "Copy"}
      aria-label={copied ? "Copied" : "Copy message"}
      className={btn}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );

  const branchButton = onBranch && (
    <button
      onClick={onBranch}
      title="Branch into a new chat from here"
      aria-label="Branch into a new chat from here"
      className={btn}
    >
      <GitBranch size={14} />
    </button>
  );

  if (variant === "user") {
    return (
      <div className="message-actions--user mt-1 flex items-center gap-0.5">
        {copyButton}
        {branchButton}
      </div>
    );
  }

  return (
    <div className="mt-1 flex items-center gap-0.5">
      {copyButton}

      <button
        onClick={() => handleFeedback("up")}
        title="Good response"
        className={`${btn} ${feedback === "up" ? "text-accent" : ""}`}
      >
        <ThumbsUp size={14} />
      </button>

      <button
        onClick={() => handleFeedback("down")}
        title="Bad response"
        className={`${btn} ${feedback === "down" ? "text-astraeya-red-500" : ""}`}
      >
        <ThumbsDown size={14} />
      </button>

      {ttsSupported && (
        <button
          onClick={handleReadAloud}
          title={!reading.active ? "Read aloud" : reading.paused ? "Continue reading" : "Pause reading"}
          aria-label={!reading.active ? "Read aloud" : reading.paused ? "Continue reading" : "Pause reading"}
          aria-pressed={reading.active && !reading.paused}
          className={`${btn} ${reading.active ? "text-[var(--accent-from)]" : ""}`}
        >
          {!reading.active ? <Volume2 size={14} /> : reading.paused ? <Play size={14} /> : <Pause size={14} />}
        </button>
      )}

      <div className="relative">
        <button
          onClick={() => setDownloadOpen((v) => !v)}
          title="Download"
          aria-label="Download this reply"
          aria-expanded={downloadOpen}
          aria-haspopup="menu"
          className={btn}
        >
          <Download size={14} />
        </button>
        {downloadOpen && (
          <div
            role="menu"
            className="absolute bottom-full left-0 z-20 mb-1 w-48 overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] py-1 text-sm shadow-lg"
          >
            <button
              role="menuitem"
              onClick={() => {
                downloadWord(content);
                setDownloadOpen(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--surface-hover)]"
            >
              <FileText size={14} /> Word document
            </button>
            <button
              role="menuitem"
              onClick={() => {
                downloadMarkdown(content);
                setDownloadOpen(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--surface-hover)]"
            >
              <FileCode size={14} /> Markdown
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setDownloadOpen(false);
                void handleShare();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--surface-hover)]"
            >
              <Share2 size={14} /> Share…
            </button>
          </div>
        )}
      </div>

      {onRetry && (
        <button onClick={onRetry} title="Try again" className={btn}>
          <RotateCcw size={14} />
        </button>
      )}

      {branchButton}
    </div>
  );
}
