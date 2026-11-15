"use client";

import { useState } from "react";
import {
  Download,
  Eye,
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

function kindOf(file: MadeFile): { label: string; Icon: typeof FileIcon } {
  const t = file.mediaType;
  const ext = file.filename.split(".").pop()?.toLowerCase() ?? "";
  if (t.startsWith("image/")) return { label: ext.toUpperCase() || "Image", Icon: ImageIcon };
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

function FileCard({ file }: { file: MadeFile }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { label, Icon } = kindOf(file);
  const size = formatSize(file.sizeBytes);
  const isImage = file.mediaType.startsWith("image/");
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
          Download
        </button>
      </div>
    </div>
  );
}

export function MadeFiles({ files }: { files: MadeFile[] }) {
  if (files.length === 0) return null;
  return (
    <div className="mt-3 flex flex-col gap-2">
      {files.map((f) => (
        <FileCard key={f.id} file={f} />
      ))}
    </div>
  );
}
