"use client";

import { Clipboard, Download, Eye, Keyboard, MessageCircle, MousePointer2, ShieldCheck } from "lucide-react";
import { AstraeyaMark } from "@/components/logo";

/**
 * Astra Assist: the Windows companion, introduced and offered for download
 * from inside the chat, where people first meet Astraeya.
 */

// Set NEXT_PUBLIC_ASSIST_DOWNLOAD_URL to the release download in production
// (for example a GitHub release asset); locally the installer is served from
// public/downloads.
const DOWNLOAD_URL = process.env.NEXT_PUBLIC_ASSIST_DOWNLOAD_URL || "/downloads/AstraAssistSetup-0.1.0.exe";

const FEATURES = [
  {
    icon: Keyboard,
    title: "One shortcut",
    body: "Press Windows + Ctrl + A to turn it on. A small Astraeya bubble follows your cursor. Press the keys again, or say \"turn off\", to stop.",
  },
  {
    icon: Eye,
    title: "Sees what you see",
    body: "Ask about whatever is on your screen: a router you're configuring in Packet Tracer, an error, a form, a spreadsheet. It reads the screen and tells you what to do next.",
  },
  {
    icon: MousePointer2,
    title: "Points the way",
    body: "It shows you exactly where to look or click with a pointer on your screen, and spots mistakes like a mistyped command.",
  },
  {
    icon: Clipboard,
    title: "Drafts for you",
    body: "\"Reply to this email professionally.\" It writes the reply and puts it on your clipboard: press Ctrl + V. Not right? Ask for another version.",
  },
  {
    icon: MessageCircle,
    title: "Just talk",
    body: "No typing back and forth. It listens, answers out loud in your Astraeya voice, and everything you discuss is saved in your chats.",
  },
  {
    icon: ShieldCheck,
    title: "You stay in control",
    body: "It only looks and listens while it's on. Each question shares a screenshot with Astraeya to be read; it's used for that answer and not kept. It guides you and never clicks or types for you.",
  },
];

export default function AssistPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <div className="flex items-center gap-3">
          <AstraeyaMark size={44} />
          <div>
            <h1 className="text-2xl font-semibold text-[var(--text-primary)]">
              Astra <span style={{ color: "var(--brand)" }}>Assist</span>
            </h1>
            <p className="text-sm text-[var(--text-secondary)]">Astraeya on your Windows PC. It sees your screen, listens, and helps out loud.</p>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <a
            href={DOWNLOAD_URL}
            download
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-[var(--accent-solid)] px-5 text-sm font-semibold text-white hover:opacity-90"
          >
            <Download size={17} />
            Download for Windows
          </a>
          <span className="text-xs text-[var(--text-secondary)]">Windows 10 and 11 · about 100 MB · version 0.1</span>
        </div>

        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <div key={title} className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
                <Icon size={16} className="text-[var(--accent-solid)]" />
                {title}
              </div>
              <p className="mt-1.5 text-sm leading-relaxed text-[var(--text-secondary)]">{body}</p>
            </div>
          ))}
        </div>

        <div className="mt-8 rounded-xl border border-[var(--border-subtle)] p-5">
          <h2 className="text-base font-semibold text-[var(--text-primary)]">Set it up in a minute</h2>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-relaxed text-[var(--text-secondary)]">
            <li>Download and open <strong>AstraAssistSetup</strong>. If Windows says it protected your PC, choose <strong>More info</strong>, then <strong>Run anyway</strong>.</li>
            <li>Sign in with your Astraeya email and password.</li>
            <li>Press <strong>Windows + Ctrl + A</strong> and start talking. Allow the microphone and screen when Windows asks.</li>
          </ol>
          <p className="mt-3 text-xs text-[var(--text-secondary)]">Coming next: say &quot;Hey Astra&quot; instead of pressing the keys.</p>
        </div>
      </div>
    </div>
  );
}
