"use client";

import { useMemo, useState } from "react";
import { Download } from "lucide-react";

/**
 * A logo, icon or illustration Astraeya drew as SVG, shown as a picture with
 * SVG and PNG downloads.
 *
 * Shown through an <img>, never inserted into the page: an SVG in an image
 * cannot run scripts or reach the page, so a hostile drawing is just a
 * picture. The PNG is drawn in the browser, so it costs no server time and
 * works offline once the reply has arrived.
 */

/** Pulls a complete <svg>…</svg> out of a code block, or null if there isn't one. */
export function extractSvg(code: string): string | null {
  const start = code.search(/<svg[\s>]/i);
  const end = code.toLowerCase().lastIndexOf("</svg>");
  if (start === -1 || end === -1 || end < start) return null;
  let svg = code.slice(start, end + "</svg>".length);
  // An <img> renders an SVG only if it declares its namespace.
  if (!/xmlns=["']http:\/\/www\.w3\.org\/2000\/svg["']/.test(svg)) {
    svg = svg.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  return svg;
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The drawing's aspect ratio from its viewBox or size, defaulting to square. */
function aspectOf(svg: string): number {
  const vb = svg.match(/viewBox=["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (vb && Number(vb[1]) > 0 && Number(vb[2]) > 0) return Number(vb[1]) / Number(vb[2]);
  const w = svg.match(/<svg[^>]*\swidth=["']([\d.]+)/i);
  const h = svg.match(/<svg[^>]*\sheight=["']([\d.]+)/i);
  if (w && h && Number(h[1]) > 0) return Number(w[1]) / Number(h[1]);
  return 1;
}

async function toPng(svg: string, longSide = 2048): Promise<Blob> {
  const aspect = aspectOf(svg);
  const width = aspect >= 1 ? longSide : Math.round(longSide * aspect);
  const height = aspect >= 1 ? Math.round(longSide / aspect) : longSide;

  const img = new Image();
  img.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("The drawing could not be rendered"));
    img.src = svgDataUrl(svg);
  });

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(img, 0, 0, width, height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG export failed"))), "image/png")
  );
}

export function SvgPreview({ svg, name = "astraeya-design" }: { svg: string; name?: string }) {
  const src = useMemo(() => svgDataUrl(svg), [svg]);
  const [error, setError] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);

  if (broken) return null; // Not a drawable SVG: the code block still shows.

  async function downloadPng() {
    setError(null);
    try {
      saveBlob(await toPng(svg), `${name}.png`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "PNG export failed");
    }
  }

  const button =
    "flex min-h-[36px] items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] px-3 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)]";

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)]">
      {/* A checkerboard shows which parts are transparent, e.g. a white logo. */}
      <div
        className="flex items-center justify-center p-6"
        style={{
          backgroundImage:
            "linear-gradient(45deg,rgba(128,128,128,.12) 25%,transparent 25%,transparent 75%,rgba(128,128,128,.12) 75%),linear-gradient(45deg,rgba(128,128,128,.12) 25%,transparent 25%,transparent 75%,rgba(128,128,128,.12) 75%)",
          backgroundSize: "20px 20px",
          backgroundPosition: "0 0,10px 10px",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt="Design preview"
          className="max-h-72 w-auto max-w-full"
          onError={() => setBroken(true)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] p-2.5">
        <button
          type="button"
          className={button}
          onClick={() => saveBlob(new Blob([svg], { type: "image/svg+xml" }), `${name}.svg`)}
        >
          <Download size={15} /> SVG
        </button>
        <button type="button" className={button} onClick={downloadPng}>
          <Download size={15} /> PNG
        </button>
        {error && <span className="text-xs text-[var(--danger)]">{error}</span>}
      </div>
    </div>
  );
}
