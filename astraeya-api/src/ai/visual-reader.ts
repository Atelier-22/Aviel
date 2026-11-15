import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { env } from "../env";

/**
 * Reading files that have no text layer — scanned PDFs, photographed pages,
 * and video — by looking at them.
 *
 * Each file is read once, when it arrives, and the result is stored as text
 * with the message. That keeps follow-up questions and conversation recall
 * working without sending the file again, and means a local model can work
 * from a document a cloud model read.
 */

/** The model that does the reading. Standard tier: good eyes, sensible cost. */
const READER_MODEL = "claude-sonnet-5-5";

/** Frames sampled from a video, evenly spaced across its length. */
const VIDEO_FRAMES = 16;

export function canReadVisually(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return client;
}

async function read(
  content: Anthropic.ContentBlockParam[],
  instruction: string
): Promise<string> {
  // Streamed so a long transcription isn't cut off by an HTTP timeout.
  const stream = getClient().messages.stream({
    model: READER_MODEL,
    max_tokens: 64000,
    output_config: { effort: "low" },
    messages: [
      { role: "user", content: [...content, { type: "text", text: instruction }] },
    ],
  });
  const message = await stream.finalMessage();
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

const PDF_INSTRUCTION = (first: number, last: number | null) => `Transcribe ${
  last === null ? "this document" : first === last ? `page ${first} of a document` : `pages ${first} to ${last} of a document`
} so it can be used without the original.

- Reproduce all the text faithfully, in reading order, page by page. Mark each page as "--- Page N ---", numbering from ${first}.
- Keep headings, numbered questions, lists and tables (as Markdown tables), and keep page order.
- Transcribe handwriting as well as you can; mark a word you cannot read as [illegible].
- Describe charts, diagrams and photos briefly in [square brackets].
- Do not summarise, answer, or comment. Output only the transcription.`;

/**
 * Pages read per request. Small enough that a dense chunk's transcription
 * fits comfortably in one reply, large enough to keep the request count low.
 */
const PAGES_PER_CHUNK = 20;
/** Chunks read at once. */
const CHUNK_CONCURRENCY = 4;
/** Beyond this, the rest of a scanned document is not read. */
export const MAX_SCANNED_PAGES = 600;

/** Splits a PDF into page ranges, each a standalone PDF. */
async function splitPdf(
  bytes: Uint8Array
): Promise<{ first: number; last: number; base64: string }[] & { totalPages?: number }> {
  const { PDFDocument } = await import("pdf-lib");
  const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const total = source.getPageCount();
  const readable = Math.min(total, MAX_SCANNED_PAGES);
  const chunks: { first: number; last: number; base64: string }[] & { totalPages?: number } = [];
  for (let start = 0; start < readable; start += PAGES_PER_CHUNK) {
    const end = Math.min(start + PAGES_PER_CHUNK, readable);
    const part = await PDFDocument.create();
    const pages = await part.copyPages(
      source,
      Array.from({ length: end - start }, (_, i) => start + i)
    );
    pages.forEach((p) => part.addPage(p));
    chunks.push({
      first: start + 1,
      last: end,
      base64: Buffer.from(await part.save()).toString("base64"),
    });
  }
  chunks.totalPages = total;
  return chunks;
}

/** Runs tasks with at most `limit` in flight, keeping results in order. */
async function inBatches<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

/** `last` is null when the page count is unknown. */
function readPdfChunk(base64: string, first: number, last: number | null): Promise<string> {
  return read(
    [
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: base64 },
      },
    ],
    PDF_INSTRUCTION(first, last)
  );
}

/**
 * Reads a scanned or image-only PDF by looking at its pages.
 *
 * Long documents are read in page ranges, several at once, then joined in
 * order. One request for a 200-page scan would be slow and could run out of
 * room for the transcription; ranges keep every page and keep the order.
 */
export async function readPdfVisually(base64: string): Promise<string> {
  let chunks: Awaited<ReturnType<typeof splitPdf>>;
  try {
    chunks = await splitPdf(Buffer.from(base64, "base64"));
  } catch {
    // A PDF pdf-lib can't parse may still be readable by the model as a whole.
    return readPdfChunk(base64, 1, null);
  }
  if (chunks.length === 0) return "";
  if (chunks.length === 1) return readPdfChunk(chunks[0].base64, chunks[0].first, chunks[0].last);

  const parts = await inBatches(chunks, CHUNK_CONCURRENCY, async (c) => {
    try {
      return await readPdfChunk(c.base64, c.first, c.last);
    } catch (err) {
      console.error(`Reading pages ${c.first}-${c.last} failed:`, err instanceof Error ? err.message : err);
      return `--- Pages ${c.first} to ${c.last} ---\n[These pages could not be read.]`;
    }
  });
  const total = chunks.totalPages ?? 0;
  const cut =
    total > MAX_SCANNED_PAGES
      ? `\n\n[Only the first ${MAX_SCANNED_PAGES} of ${total} pages were read.]`
      : "";
  return parts.join("\n\n") + cut;
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

function ffmpegPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("@ffmpeg-installer/ffmpeg") as { path: string }).path;
}

function run(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

/** Seconds, parsed from ffmpeg's "Duration: 00:01:23.45" banner. */
function parseDuration(stderr: string): number | null {
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** Pulls evenly spaced JPEG frames out of a video. */
export async function sampleVideoFrames(
  base64: string,
  extension: string
): Promise<{ frames: { seconds: number; data: string }[]; duration: number }> {
  const dir = await mkdtemp(path.join(tmpdir(), "astraeya-video-"));
  try {
    const input = path.join(dir, `input.${extension}`);
    await writeFile(input, Buffer.from(base64, "base64"));

    const ffmpeg = ffmpegPath();
    // `-i` alone prints the duration and exits non-zero; that is expected.
    const probe = await run(ffmpeg, ["-hide_banner", "-i", input]);
    const duration = parseDuration(probe.stderr);
    if (!duration || duration <= 0) throw new Error("not a readable video");

    const every = Math.max(duration / VIDEO_FRAMES, 0.5);
    const result = await run(ffmpeg, [
      "-hide_banner",
      "-loglevel", "error",
      "-i", input,
      "-vf", `fps=1/${every.toFixed(3)},scale='min(1024,iw)':-2`,
      "-frames:v", String(VIDEO_FRAMES),
      "-q:v", "4",
      path.join(dir, "frame-%02d.jpg"),
    ]);
    if (result.code !== 0) throw new Error(result.stderr.slice(0, 200));

    const files = (await readdir(dir)).filter((f) => f.startsWith("frame-")).sort();
    const frames = await Promise.all(
      files.map(async (f, i) => ({
        seconds: Math.round(i * every),
        data: (await readFile(path.join(dir, f))).toString("base64"),
      }))
    );
    if (frames.length === 0) throw new Error("no frames could be extracted");
    return { frames, duration };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const VIDEO_INSTRUCTION = (duration: number, count: number) =>
  `These are ${count} frames taken at even intervals from a ${Math.round(duration)}-second video, in order, each labelled with its time.

Describe the video so someone can answer questions about it without watching it:
- What it is (lecture, tutorial, experiment, recording, etc.) and what happens, in order, with times.
- Transcribe any on-screen text, slides, equations, code or captions exactly.
- Note people, objects, places, diagrams and anything that changes between frames.
- You cannot hear the audio. Do not guess what was said.
Output only the description.`;

/** Reads a video by sampling frames and describing them. */
export async function readVideoVisually(
  base64: string,
  extension: string
): Promise<string> {
  const { frames, duration } = await sampleVideoFrames(base64, extension);
  const content: Anthropic.ContentBlockParam[] = frames.flatMap((f) => [
    { type: "text" as const, text: `Frame at ${f.seconds}s:` },
    {
      type: "image" as const,
      source: { type: "base64" as const, media_type: "image/jpeg" as const, data: f.data },
    },
  ]);
  const description = await read(content, VIDEO_INSTRUCTION(duration, frames.length));
  return `[Video, ${Math.round(duration)} seconds. Read from ${frames.length} still frames — the audio could not be heard.]\n\n${description}`;
}
