/**
 * Reading attached documents.
 *
 * Text is extracted on the server, once, when the file arrives. That makes a
 * document readable by every model — cloud or local — and lets later turns in
 * the same conversation (and conversation recall) see it without the file
 * being uploaded again.
 */

import {
  canReadVisually,
  readPdfVisually,
  readVideoVisually,
} from "../ai/visual-reader";

/**
 * Roughly 250k tokens of text per document: a dense 300-page book. The
 * hosted models have a 1M-token context, and the document is cached after
 * the first turn, so a long one costs little to keep asking about.
 */
export const MAX_DOCUMENT_CHARS = 1_000_000;

export interface DocumentAttachment {
  name: string;
  mediaType: string;
  base64: string;
}

export interface ExtractedDocument {
  name: string;
  /** Null when the format can't be read; `error` says why. */
  text: string | null;
  truncated: boolean;
  error?: string;
}

const TEXT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);

const DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Video types, and the file extension ffmpeg should be given for each. */
export const VIDEO_TYPES: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/3gpp": "3gp",
  "video/x-msvideo": "avi",
};

/**
 * Fewer characters than this per page means the PDF is (mostly) scanned
 * images: a real text layer carries far more than a page number or a header.
 */
const MIN_CHARS_PER_PAGE = 40;

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Slide text from a .pptx, slide by slide, speaker notes included. */
async function extractPptx(bytes: Buffer): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  const order = (name: string) => Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0);
  const textOf = (xml: string) =>
    [...xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)]
      .map((p) =>
        [...p[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => decodeXml(t[1])).join("")
      )
      .filter((line) => line.trim())
      .join("\n");

  const slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => order(a) - order(b));

  const parts: string[] = [];
  for (const name of slides) {
    const n = order(name);
    const body = textOf(await zip.file(name)!.async("string"));
    const notesFile = zip.file(`ppt/notesSlides/notesSlide${n}.xml`);
    const notes = notesFile ? textOf(await notesFile.async("string")) : "";
    parts.push(
      `--- Slide ${n} ---\n${body}${notes ? `\n[Speaker notes] ${notes}` : ""}`
    );
  }
  return parts.join("\n\n");
}

/** Every sheet of an .xlsx as rows of tab-separated cells. */
async function extractXlsx(bytes: Buffer): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);

  const shared: string[] = [];
  const sharedXml = await zip.file("xl/sharedStrings.xml")?.async("string");
  if (sharedXml) {
    for (const si of sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push(
        [...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1])).join("")
      );
    }
  }

  const workbook = (await zip.file("xl/workbook.xml")?.async("string")) ?? "";
  const names = [...workbook.matchAll(/<sheet\b[^>]*name="([^"]*)"/g)].map((m) =>
    decodeXml(m[1])
  );

  const sheetFiles = Object.keys(zip.files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]));

  const parts: string[] = [];
  for (const [i, file] of sheetFiles.entries()) {
    const xml = await zip.file(file)!.async("string");
    const rows: string[] = [];
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [...row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(
        (c) => {
          const attrs = c[1];
          const inner = c[2] ?? "";
          const type = attrs.match(/\bt="([^"]+)"/)?.[1];
          if (type === "inlineStr") {
            return decodeXml(inner.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "");
          }
          const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "";
          return type === "s" ? (shared[Number(v)] ?? "") : decodeXml(v);
        }
      );
      if (cells.some((c) => c.trim())) rows.push(cells.join("\t"));
    }
    parts.push(`--- Sheet: ${names[i] ?? `Sheet ${i + 1}`} ---\n${rows.join("\n")}`);
  }
  return parts.join("\n\n");
}

interface RawResult {
  text: string;
  /** Pages in a PDF, so a scanned one can be recognised. */
  pages?: number;
}

async function extractRaw(doc: DocumentAttachment): Promise<RawResult> {
  const bytes = Buffer.from(doc.base64, "base64");

  if (TEXT_TYPES.has(doc.mediaType) || doc.mediaType.startsWith("text/")) {
    return { text: bytes.toString("utf8") };
  }

  if (doc.mediaType === "application/pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text, totalPages } = await extractText(pdf, { mergePages: true });
    return { text: Array.isArray(text) ? text.join("\n\n") : text, pages: totalPages };
  }

  if (doc.mediaType === DOCX) {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: bytes });
    return { text: value };
  }

  if (doc.mediaType === PPTX) return { text: await extractPptx(bytes) };
  if (doc.mediaType === XLSX) return { text: await extractXlsx(bytes) };

  throw new Error("unsupported");
}

export interface ExtractOptions {
  /**
   * Whether a scanned PDF or a video may be sent to the hosted model to be
   * read. Off for accounts that process everything locally.
   */
  allowVisualReading?: boolean;
}

export async function extractDocument(
  doc: DocumentAttachment,
  options: ExtractOptions = {}
): Promise<ExtractedDocument> {
  const visual = options.allowVisualReading && canReadVisually();

  // Video has no text layer at all; it is always read by looking at it.
  const videoExt = VIDEO_TYPES[doc.mediaType];
  if (videoExt) {
    if (!visual) {
      return {
        name: doc.name,
        text: null,
        truncated: false,
        error: "videos can only be watched by the hosted AI, which is not available for this account",
      };
    }
    try {
      return finish(doc.name, await readVideoVisually(doc.base64, videoExt));
    } catch (err) {
      console.error(`Video reading failed for "${doc.name}":`, err instanceof Error ? err.message : err);
      return {
        name: doc.name,
        text: null,
        truncated: false,
        error: "the video could not be read — it may be damaged or in an unusual format (MP4 works best)",
      };
    }
  }

  try {
    const result = await extractRaw(doc);
    let raw = result.text.replace(/\n{3,}/g, "\n\n").trim();

    // A scanned PDF has little or no text layer. Read the pages as images.
    const scanned =
      doc.mediaType === "application/pdf" &&
      raw.length < MIN_CHARS_PER_PAGE * Math.max(result.pages ?? 1, 1);
    if (scanned && visual) {
      try {
        const seen = await readPdfVisually(doc.base64);
        if (seen) raw = `[Scanned document — read from the page images.]\n\n${seen}`;
      } catch (err) {
        console.error(`Visual reading failed for "${doc.name}":`, err instanceof Error ? err.message : err);
      }
    }

    if (!raw) {
      return {
        name: doc.name,
        text: null,
        truncated: false,
        error: visual
          ? "no text could be found, even reading the pages as images"
          : "no readable text was found (it may be a scanned document or image-only PDF)",
      };
    }
    return finish(doc.name, raw);
  } catch (err) {
    const unsupported = err instanceof Error && err.message === "unsupported";
    if (!unsupported) {
      console.error(
        `Document extraction failed for "${doc.name}":`,
        err instanceof Error ? err.message : err
      );
    }
    return {
      name: doc.name,
      text: null,
      truncated: false,
      error: unsupported
        ? "this file type can't be read yet — PDF, Word, PowerPoint, Excel, text, CSV, JSON and video can"
        : "the file could not be read — it may be damaged or password-protected",
    };
  }
}

function finish(name: string, raw: string): ExtractedDocument {
  const truncated = raw.length > MAX_DOCUMENT_CHARS;
  return {
    name,
    text: truncated ? raw.slice(0, MAX_DOCUMENT_CHARS) : raw,
    truncated,
  };
}

/**
 * The block stored alongside the user's message and replayed to the model.
 * Fenced so the model treats it as material to work with, not instructions.
 */
export function formatDocuments(docs: ExtractedDocument[]): string {
  return docs
    .map((d) => {
      if (d.text === null) {
        return `<document name="${d.name}" readable="false">\nThis document could not be read: ${d.error}.\n</document>`;
      }
      const note = d.truncated
        ? `\n[The document was longer than ${MAX_DOCUMENT_CHARS.toLocaleString()} characters; only the beginning is included.]`
        : "";
      return `<document name="${d.name}">\n${d.text}${note}\n</document>`;
    })
    .join("\n\n");
}
