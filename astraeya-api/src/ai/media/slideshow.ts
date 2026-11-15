/**
 * Slideshow videos: slides of text over colour or pictures, faded one into the
 * next, rendered here with ffmpeg. No video model, so they cost next to
 * nothing and are ready in seconds. Good for school presentations, explainers
 * and simple birthday cards.
 *
 * Each slide is drawn as SVG and rasterised with resvg, which sidesteps
 * ffmpeg's text filters and the fonts they need.
 */

import { Resvg } from "@resvg/resvg-js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ffmpegPath, run } from "../visual-reader";

export type AspectRatio = "16:9" | "9:16" | "1:1";

export interface Slide {
  heading?: string;
  text?: string;
  /** PNG or JPEG bytes to fill the slide behind the text. */
  image?: { mediaType: string; bytes: Buffer };
}

export interface SlideshowOptions {
  slides: Slide[];
  aspectRatio: AspectRatio;
  secondsPerSlide: number;
  /** Two hex colours for slides without a picture. */
  palette?: [string, string];
}

const SIZES: Record<AspectRatio, { w: number; h: number }> = {
  "16:9": { w: 1280, h: 720 },
  "9:16": { w: 720, h: 1280 },
  "1:1": { w: 1080, h: 1080 },
};

const FADE = 0.5;

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

/** Greedy word wrap by an estimated character width. */
function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const lines: string[] = [];
  for (const para of text.split(/\n+/)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if ((line + " " + word).trim().length > maxChars && line) {
        lines.push(line);
        line = word;
      } else {
        line = (line + " " + word).trim();
      }
    }
    if (line) lines.push(line);
  }
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/\s*\S*$/, "") + "…";
    return kept;
  }
  return lines;
}

export function slideSvg(slide: Slide, ratio: AspectRatio, palette: [string, string], index: number): string {
  const { w, h } = SIZES[ratio];
  const pad = Math.round(Math.min(w, h) * 0.08);
  const headingSize = Math.round(Math.min(w, h) * (ratio === "9:16" ? 0.075 : 0.085));
  const bodySize = Math.round(headingSize * 0.52);
  const usable = w - pad * 2;
  const headingLines = slide.heading ? wrap(slide.heading, Math.floor(usable / (headingSize * 0.55)), 3) : [];
  const bodyLines = slide.text ? wrap(slide.text, Math.floor(usable / (bodySize * 0.5)), ratio === "9:16" ? 12 : 7) : [];

  const blockHeight = headingLines.length * headingSize * 1.15 + (bodyLines.length ? headingSize * 0.5 : 0) + bodyLines.length * bodySize * 1.4;
  // Over a picture, text sits at the bottom on a dark band; on colour, centred.
  let y = slide.image ? h - pad - blockHeight + headingSize : (h - blockHeight) / 2 + headingSize;

  const parts: string[] = [];
  const [c1, c2] = palette;
  parts.push(
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>` +
      `<linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0.35" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.78"/></linearGradient></defs>`
  );
  parts.push(`<rect width="${w}" height="${h}" fill="url(#bg)"/>`);
  if (slide.image) {
    parts.push(
      `<image href="data:${slide.image.mediaType};base64,${slide.image.bytes.toString("base64")}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/>`
    );
    parts.push(`<rect width="${w}" height="${h}" fill="url(#shade)"/>`);
  } else {
    // A quiet shape so plain slides are not flat.
    parts.push(`<circle cx="${w * (index % 2 ? 0.1 : 0.9)}" cy="${h * 0.15}" r="${Math.min(w, h) * 0.35}" fill="#fff" fill-opacity="0.06"/>`);
  }

  const anchor = slide.image ? "start" : "middle";
  const x = slide.image ? pad : w / 2;
  for (const line of headingLines) {
    parts.push(`<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-weight="700" font-size="${headingSize}" fill="#fff">${escapeXml(line)}</text>`);
    y += headingSize * 1.15;
  }
  if (bodyLines.length) y += headingSize * 0.5 - bodySize * 0.4;
  for (const line of bodyLines) {
    parts.push(`<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="${bodySize}" fill="#fff" fill-opacity="0.92">${escapeXml(line)}</text>`);
    y += bodySize * 1.4;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join("")}</svg>`;
}

export function renderSvgToPng(svg: string, width?: number): Buffer {
  const resvg = new Resvg(svg, {
    font: { loadSystemFonts: true, defaultFontFamily: "Arial" },
    ...(width ? { fitTo: { mode: "width" as const, value: width } } : {}),
  });
  return Buffer.from(resvg.render().asPng());
}

/** Renders the slides into an H.264 MP4 that plays on any phone. */
export async function renderSlideshow(opts: SlideshowOptions): Promise<{ mp4: Buffer; framesPng: Buffer[]; seconds: number }> {
  const palette = opts.palette ?? ["#1f2a5c", "#7a3e9d"];
  const d = Math.min(Math.max(opts.secondsPerSlide, 2), 10);
  const dir = await mkdtemp(path.join(tmpdir(), "astraeya-slides-"));
  try {
    const framesPng = opts.slides.map((s, i) => renderSvgToPng(slideSvg(s, opts.aspectRatio, palette, i)));
    const inputs: string[] = [];
    for (let i = 0; i < framesPng.length; i++) {
      const file = path.join(dir, `slide-${String(i).padStart(2, "0")}.png`);
      await writeFile(file, framesPng[i]);
      // One still per slide: zoompan turns it into d seconds of frames.
      inputs.push("-i", file);
    }
    // Each slide fades in and out, with a slow push-in, then all are joined.
    const n = framesPng.length;
    const { w, h } = SIZES[opts.aspectRatio];
    const chains = framesPng.map(
      (_, i) =>
        `[${i}:v]scale=${w * 2}:${h * 2},zoompan=z='min(zoom+0.0006,1.06)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.round(d * 30)}:s=${w}x${h}:fps=30,` +
        // The first slide starts fully visible, so the player's still frame
        // shows the video rather than black.
        `${i === 0 ? "" : `fade=t=in:st=0:d=${FADE},`}fade=t=out:st=${(d - FADE).toFixed(2)}:d=${FADE},format=yuv420p,setsar=1[v${i}]`
    );
    const filter = `${chains.join(";")};${framesPng.map((_, i) => `[v${i}]`).join("")}concat=n=${n}:v=1:a=0[out]`;
    const output = path.join(dir, "slideshow.mp4");
    const result = await run(ffmpegPath(), [
      "-hide_banner", "-loglevel", "error", "-y",
      ...inputs,
      // A silent track, so players that expect audio do not complain.
      "-f", "lavfi", "-t", String(d * n), "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-filter_complex", filter,
      "-map", "[out]", "-map", `${n}:a`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", "-movflags", "+faststart",
      output,
    ]);
    if (result.code !== 0) throw new Error(`ffmpeg failed: ${result.stderr.slice(0, 300)}`);
    return { mp4: await readFile(output), framesPng, seconds: d * n };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
