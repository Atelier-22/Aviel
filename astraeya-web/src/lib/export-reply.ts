import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Saving a reply as a file, entirely in the browser — nothing is uploaded, so
 * it is instant and works offline.
 */

function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A filename from the reply's first heading or line. */
export function filenameFor(markdown: string, ext: string): string {
  const first =
    markdown.match(/^#{1,3}\s+(.+)$/m)?.[1] ?? markdown.split("\n").find((l) => l.trim()) ?? "Astraeya";
  const base = first
    .replace(/[*_`#>[\]()]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .slice(0, 60)
    .replace(/\s+/g, " ");
  return `${base || "Astraeya"}.${ext}`;
}

export function downloadMarkdown(markdown: string) {
  save(new Blob([markdown], { type: "text/markdown;charset=utf-8" }), filenameFor(markdown, "md"));
}

/**
 * A Word document. Word opens HTML saved with a .doc extension and keeps the
 * headings, lists, bold and tables, so the reply arrives formatted and ready to
 * edit — no conversion service, no extra library.
 */
export function downloadWord(markdown: string) {
  const body = renderToStaticMarkup(
    createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdown)
  );
  const html = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
<head><meta charset="utf-8"><title>Astraeya</title>
<style>
  body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; line-height: 1.5; }
  h1 { font-size: 18pt; } h2 { font-size: 15pt; } h3 { font-size: 12.5pt; }
  table { border-collapse: collapse; } th, td { border: 1px solid #999; padding: 4pt 6pt; vertical-align: top; }
  th { background: #eef2f8; }
  code { font-family: Consolas, monospace; } pre { background: #f4f4f4; padding: 6pt; }
  blockquote { border-left: 3pt solid #1e6bff; margin-left: 0; padding-left: 8pt; color: #444; }
</style></head>
<body>${body}</body></html>`;
  save(new Blob(["﻿", html], { type: "application/msword" }), filenameFor(markdown, "doc"));
}
