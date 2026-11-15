"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  Copy,
  Download,
  Eye,
  Film,
  Link2,
  RefreshCw,
  Share2,
  X,
  FileArchive,
  FileCode,
  FileSpreadsheet,
  FileText,
  File as FileIcon,
  Image as ImageIcon,
  Loader2,
  Presentation,
} from "lucide-react";
import { API_BASE_URL } from "@/lib/api";
import { apiFetch } from "@/lib/api-client";

const CODE_EXTS: Record<string, string> = {
  html: "Web page", htm: "Web page", css: "Stylesheet", js: "JavaScript", ts: "TypeScript",
  py: "Python", json: "JSON", java: "Java", c: "C", cpp: "C++", sql: "SQL", txt: "Text",
};

/** A file Astraeya made, as the API hands it over: a signed, expiring link. */
export type MadeFile = {
  id: string;
  filename: string;
  mediaType: string;
  sizeBytes: number | null;
  /** Relative to the API base URL. */
  url: string;
  expiresAt: string;
};

/** A video being made in the background, as the API reports it. */
export type MediaJob = {
  id: string;
  kind: "video" | "slideshow" | string;
  status: "queued" | "processing" | "done" | "failed" | string;
  prompt: string;
  error: string | null;
  createdAt: string;
  file: MadeFile | null;
};

function kindOf(file: MadeFile): { label: string; Icon: typeof FileIcon } {
  const t = file.mediaType;
  const ext = file.filename.split(".").pop()?.toLowerCase() ?? "";
  if (t === "image/svg+xml") return { label: "SVG vector", Icon: ImageIcon };
  if (t.startsWith("image/")) return { label: ext.toUpperCase() || "Image", Icon: ImageIcon };
  if (t.startsWith("video/")) return { label: "Video", Icon: Film };
  if (t.includes("presentation") || ext === "pptx") return { label: "PowerPoint", Icon: Presentation };
  if (t.includes("spreadsheet") || ext === "xlsx") return { label: "Excel", Icon: FileSpreadsheet };
  if (t === "text/csv" || ext === "csv") return { label: "CSV", Icon: FileSpreadsheet };
  if (t.includes("wordprocessing") || ext === "docx") return { label: "Word", Icon: FileText };
  if (t === "application/pdf" || ext === "pdf") return { label: "PDF", Icon: FileText };
  if (ext === "md") return { label: "Markdown", Icon: FileText };
  if (t.includes("zip") || ext === "zip") return { label: "Zip folder", Icon: FileArchive };
  if (CODE_EXTS[ext]) return { label: CODE_EXTS[ext], Icon: FileCode };
  return { label: ext.toUpperCase() || "File", Icon: FileIcon };
}

function formatSize(bytes: number | null): string | null {
  if (!bytes) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The link if it still has a minute left, otherwise a fresh one from the API. */
async function liveUrl(file: MadeFile): Promise<string> {
  if (new Date(file.expiresAt).getTime() - Date.now() > 60_000) {
    return `${API_BASE_URL}${file.url}`;
  }
  const fresh = await apiFetch<MadeFile>(`/files/${file.id}/link`);
  return `${API_BASE_URL}${fresh.url}`;
}

type ShareLink = { id: string; url?: string; expiresAt: string | null };

const actionButton =
  "flex min-h-[40px] items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-60";

/**
 * Makes a link anyone can open, without an account. Nothing is shared until
 * the person presses the button; the link expires and can be turned off.
 */
function SharePanel({ file, onClose }: { file: MadeFile; onClose: () => void }) {
  const [days, setDays] = useState(7);
  const [link, setLink] = useState<ShareLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      setLink(
        await apiFetch<ShareLink>(`/files/${file.id}/share`, {
          method: "POST",
          body: JSON.stringify({ expiresInDays: days }),
        })
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't make a link. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const fullUrl = link?.url ? `${API_BASE_URL}${link.url}` : "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy. Select the link and copy it yourself.");
    }
  }

  async function shareNative() {
    try {
      await navigator.share({ title: file.filename, url: fullUrl });
    } catch {
      /* the person closed the share sheet */
    }
  }

  async function revoke() {
    if (!link) return;
    setBusy(true);
    try {
      await apiFetch(`/files/shares/${link.id}`, { method: "DELETE" });
      setLink(null);
      onClose();
    } catch {
      setError("Couldn't turn the link off. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-[var(--border-subtle)] p-3 text-sm">
      {!link ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[var(--text-secondary)]">Anyone with the link can open it for</span>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="min-h-[36px] rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-2 text-[var(--text-primary)]"
            aria-label="How long the link works"
          >
            <option value={1}>1 day</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
          </select>
          <button
            type="button"
            onClick={create}
            disabled={busy}
            className="flex min-h-[36px] items-center gap-1.5 rounded-lg bg-[var(--accent-solid)] px-3 font-medium text-white disabled:opacity-60"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
            Create link
          </button>
          <button type="button" onClick={onClose} className={actionButton} aria-label="Close sharing">
            <X size={16} />
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={fullUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="min-h-[36px] min-w-0 flex-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-2 text-xs text-[var(--text-primary)]"
              aria-label="Share link"
            />
            <button type="button" onClick={copy} className={actionButton}>
              {copied ? <Check size={16} /> : <Copy size={16} />}
              {copied ? "Copied" : "Copy"}
            </button>
            {typeof navigator !== "undefined" && "share" in navigator && (
              <button type="button" onClick={shareNative} className={actionButton} aria-label="Share with an app">
                <Share2 size={16} />
              </button>
            )}
          </div>
          <span className="text-xs text-[var(--text-secondary)]">
            Works until {link.expiresAt ? new Date(link.expiresAt).toLocaleDateString() : "you turn it off"}, or
            until the file is deleted.{" "}
            <button type="button" onClick={revoke} disabled={busy} className="underline hover:text-[var(--danger)]">
              Turn this link off
            </button>
          </span>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-[var(--danger)]">{error}</p>}
    </div>
  );
}

function FileCard({ file, onRegenerate }: { file: MadeFile; onRegenerate?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const { label, Icon } = kindOf(file);
  const size = formatSize(file.sizeBytes);
  // SVGs are never shown inline: a made SVG must not run on this site.
  const isImage = file.mediaType.startsWith("image/") && file.mediaType !== "image/svg+xml";
  const isVideo = file.mediaType.startsWith("video/");
  const isPdf = file.mediaType === "application/pdf";

  // Opens in the browser's own PDF viewer, which on a phone is the system one.
  async function preview() {
    setError(null);
    const tab = window.open("", "_blank");
    try {
      const url = `${await liveUrl(file)}&inline=1`;
      if (tab) tab.location.href = url;
      else window.location.href = url;
    } catch {
      tab?.close();
      setError("Couldn't open the file. It may have expired; ask again to remake it.");
    }
  }

  // A plain navigation rather than fetch-and-blob: phones hand it to their own
  // download manager, which copes with slow connections and resumes.
  async function download() {
    setBusy(true);
    setError(null);
    try {
      window.location.href = await liveUrl(file);
    } catch {
      setError("Couldn't get the file. It may have expired; ask again to remake it.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex w-full max-w-md flex-col overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)]">
      {isImage && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`${API_BASE_URL}${file.url}&inline=1`}
          alt={file.filename}
          loading="lazy"
          className="max-h-72 w-full bg-[var(--bg-secondary)] object-contain"
        />
      )}
      {isVideo && (
        <video
          src={`${API_BASE_URL}${file.url}&inline=1`}
          controls
          playsInline
          preload="metadata"
          className="max-h-96 w-full bg-black"
        />
      )}
      <div className="flex items-center gap-3 p-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent-solid)]">
          <Icon size={20} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-[var(--text-primary)]">
            {file.filename}
          </span>
          <span className="block text-xs text-[var(--text-secondary)]">
            {[label, size].filter(Boolean).join(" · ")}
            {error && <span className="ml-1 text-[var(--danger)]">{error}</span>}
          </span>
        </span>
        {isPdf && (
          <button
            type="button"
            onClick={preview}
            className="flex min-h-[40px] items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
            aria-label={`Preview ${file.filename}`}
          >
            <Eye size={16} />
            <span className="max-sm:sr-only">Preview</span>
          </button>
        )}
        <button
          type="button"
          onClick={download}
          disabled={busy}
          className="flex min-h-[40px] items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] px-3 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-60"
          aria-label={`Download ${file.filename}`}
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
          <span className="max-sm:sr-only">Download</span>
        </button>
      </div>
      <div className="-mt-2 flex items-center gap-1 px-2 pb-2">
        <button
          type="button"
          onClick={() => setSharing((v) => !v)}
          className={actionButton}
          aria-expanded={sharing}
          aria-label={`Share ${file.filename}`}
        >
          <Share2 size={16} />
          Share link
        </button>
        {isImage && onRegenerate && (
          <button type="button" onClick={onRegenerate} className={actionButton} aria-label="Make another version">
            <RefreshCw size={16} />
            Regenerate
          </button>
        )}
      </div>
      {sharing && <SharePanel file={file} onClose={() => setSharing(false)} />}
    </div>
  );
}

/** Says so when a video finishes while the person is in another tab. */
function notifyReady(job: MediaJob) {
  if (typeof document === "undefined" || !document.hidden) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const n = new Notification(job.status === "done" ? "Your video is ready" : "Your video could not be made", {
    body: job.prompt.slice(0, 100),
    icon: "/icon.png",
  });
  n.onclick = () => {
    window.focus();
    n.close();
  };
}

/**
 * A video being made. Polls until it is done, then becomes the player.
 * Reloading the page picks it up again, so leaving does not lose it.
 */
function JobCard({ job: initial, onRegenerate }: { job: MediaJob; onRegenerate?: () => void }) {
  const [job, setJob] = useState(initial);
  const [canAsk, setCanAsk] = useState(false);
  const started = useRef(Date.now());

  useEffect(() => {
    setCanAsk(typeof Notification !== "undefined" && Notification.permission === "default");
  }, []);

  useEffect(() => {
    if (job.status === "done" || job.status === "failed") return;
    let stopped = false;
    const poll = async () => {
      try {
        const next = await apiFetch<MediaJob>(`/media/jobs/${job.id}`);
        if (stopped) return;
        setJob(next);
        if (next.status === "done" || next.status === "failed") notifyReady(next);
      } catch {
        /* a missed poll is retried on the next tick */
      }
    };
    // Quick at first (slideshows take seconds), then gentler.
    const interval = Date.now() - started.current < 60_000 ? 3000 : 8000;
    const timer = setInterval(poll, interval);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [job.id, job.status]);

  if (job.status === "done" && job.file) return <FileCard file={job.file} onRegenerate={onRegenerate} />;

  if (job.status === "failed") {
    return (
      <div className="flex w-full max-w-md items-start gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-3" role="alert">
        <AlertCircle size={20} className="mt-0.5 shrink-0 text-[var(--danger)]" />
        <span className="text-sm">
          <span className="block font-medium text-[var(--text-primary)]">The video was not made</span>
          <span className="block text-[var(--text-secondary)]">{job.error ?? "Something went wrong. Try again."}</span>
        </span>
      </div>
    );
  }

  const label = job.kind === "slideshow" ? "Making your slideshow…" : job.status === "queued" ? "Waiting for a turn…" : "Making your video…";
  const hint = job.kind === "slideshow" ? "Usually under a minute." : "Usually 2–5 minutes. You can keep chatting or leave this page.";

  return (
    <div className="flex w-full max-w-md flex-col gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-3" role="status">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent-solid)]">
          <Loader2 size={20} className="animate-spin" />
        </span>
        <span className="min-w-0 flex-1 text-sm">
          <span className="block font-medium text-[var(--text-primary)]">{label}</span>
          <span className="block text-[var(--text-secondary)]">{hint}</span>
        </span>
      </div>
      {canAsk && job.kind === "video" && (
        <button
          type="button"
          onClick={async () => {
            await Notification.requestPermission();
            setCanAsk(false);
          }}
          className="self-start text-xs text-[var(--accent-solid)] underline"
        >
          Notify me when it&apos;s ready
        </button>
      )}
    </div>
  );
}

export function MadeFiles({
  files = [],
  jobs = [],
  onRegenerate,
}: {
  files?: MadeFile[];
  jobs?: MediaJob[];
  onRegenerate?: () => void;
}) {
  // A finished video is also listed among the files after a reload.
  const fileIds = new Set(files.map((f) => f.id));
  const openJobs = jobs.filter((j) => !(j.file && fileIds.has(j.file.id)));
  if (files.length === 0 && openJobs.length === 0) return null;
  return (
    <div className="mt-3 flex flex-col gap-2">
      {files.map((f) => (
        <FileCard key={f.id} file={f} onRegenerate={onRegenerate} />
      ))}
      {openJobs.map((j) => (
        <JobCard key={j.id} job={j} onRegenerate={onRegenerate} />
      ))}
    </div>
  );
}
