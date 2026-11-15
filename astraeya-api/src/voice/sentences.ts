/**
 * Turning a reply into sentences to speak, one at a time.
 *
 * The first sentence is sent to the voice server as soon as it is complete,
 * so speech starts while the rest is still being written or made. Markdown is
 * reduced to what a person would say aloud: no code blocks, URLs, table pipes
 * or emphasis markers.
 *
 * The same file is used by the web app (astraeya-web/src/lib/voice/sentences.ts);
 * keep the two identical.
 */

/** Longer than this, a sentence is split at a comma or semicolon. */
const MAX_SENTENCE = 260;

const ABBREVIATIONS = [
  "Mr", "Mrs", "Ms", "Dr", "Prof", "Sr", "Jr", "St", "vs", "etc", "e.g", "i.e", "No", "Fig", "approx", "Inc", "Ltd", "Co", "Jan", "Feb", "Mar", "Apr", "Jun", "Jul", "Aug", "Sep", "Sept", "Oct", "Nov", "Dec",
];
const ABBREV = new RegExp(`\\b(?:${ABBREVIATIONS.map((a) => a.replace(".", "\\.")).join("|")})\\.$`, "i");

/** Markdown to plain speakable text. */
export function speakableText(markdown: string): string {
  return (
    markdown
      // Code blocks are read on screen, not aloud.
      .replace(/```[\s\S]*?(```|$)/g, "\n")
      .replace(/`([^`]*)`/g, "$1")
      // Images vanish; links keep their words.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "")
      // Tables: separator rows go, cells become a list.
      .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, "")
      .replace(/\|/g, ", ")
      .replace(/<[^>]+>/g, "")
      // Headings, quotes, list markers and emphasis.
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s*>\s?/gm, "")
      .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, "\n")
      .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
      .replace(/[ \t]+/g, " ")
  );
}

/** Splits a sentence that is too long to start speaking quickly. */
function splitLong(sentence: string): string[] {
  if (sentence.length <= MAX_SENTENCE) return [sentence];
  const out: string[] = [];
  let rest = sentence;
  while (rest.length > MAX_SENTENCE) {
    const window = rest.slice(0, MAX_SENTENCE);
    const cut = Math.max(window.lastIndexOf("; "), window.lastIndexOf(", "), window.lastIndexOf(" – "), window.lastIndexOf(" - "));
    const at = cut > 60 ? cut + 1 : window.lastIndexOf(" ") > 60 ? window.lastIndexOf(" ") : MAX_SENTENCE;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Text with no letter or digit is not worth a request ("—", "..."). */
function speakable(s: string): boolean {
  return /[\p{L}\p{N}]/u.test(s);
}

/**
 * Finds where complete sentences end in `text`. Returns the sentences and the
 * unfinished remainder. A sentence ends at . ! ? or … followed by a space and
 * the start of a new sentence, or at a line break.
 */
function cut(text: string, final: boolean): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") {
      const s = text.slice(start, i).trim();
      if (s) sentences.push(s);
      start = i + 1;
      continue;
    }
    if (!".!?…".includes(ch)) continue;
    // Swallow closing quotes and brackets, and runs like "?!" or "...".
    let end = i + 1;
    while (end < text.length && /[.!?…"'”’)\]]/.test(text[end])) end++;
    if (end >= text.length) break; // might continue in the next chunk
    if (!/\s/.test(text[end])) continue; // "3.14", "e.g.x", "U.S.A"
    const candidate = text.slice(start, end).trim();
    // "Dr. Okello", "e.g. this": not the end of a sentence.
    if (ch === "." && ABBREV.test(candidate)) continue;
    // A single initial: "J. K. Rowling".
    if (ch === "." && /(?:^|\s)\p{Lu}\.$/u.test(candidate)) continue;
    const next = text.slice(end).trimStart()[0];
    if (next && /\p{Ll}/u.test(next)) continue; // "approx. three"
    sentences.push(candidate);
    start = end;
    i = end - 1;
  }
  let rest = text.slice(start);
  if (final) {
    const last = rest.trim();
    if (last) sentences.push(last);
    rest = "";
  }
  return { sentences: sentences.flatMap(splitLong).filter(speakable), rest };
}

/** All the sentences in a finished reply. */
export function splitSentences(markdown: string): string[] {
  return cut(speakableText(markdown), true).sentences;
}

/**
 * Sentences from a reply that is still arriving. Feed it text as it streams;
 * each call returns the sentences completed so far. Call end() at the end.
 */
export class SentenceStream {
  private raw = "";
  private emitted = 0;

  push(chunk: string): string[] {
    this.raw += chunk;
    // Inside an open code block nothing is spoken until it closes.
    const fences = (this.raw.match(/```/g) ?? []).length;
    if (fences % 2 === 1) return [];
    return this.take(false);
  }

  end(): string[] {
    return this.take(true);
  }

  private take(final: boolean): string[] {
    const { sentences } = cut(speakableText(this.raw), final);
    const fresh = sentences.slice(this.emitted);
    this.emitted = sentences.length;
    return fresh;
  }
}
