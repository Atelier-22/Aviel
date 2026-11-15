/**
 * Does this message ask Astraeya to *make a file* or *edit an image*?
 *
 * Making files runs code in a sandbox, which takes longer than a normal reply,
 * so it is switched on only for messages that ask for it. Logos and icons are
 * not here: they are drawn as SVG in an ordinary reply, which is faster.
 */

const MAKE =
  /\b(make|create|generate|build|produce|draft|write|prepare|design|turn|convert|export|save|put|compile|format|plot|draw|visuali[sz]e|give me|i need|can you (?:make|create|do))\b/i;

const FILE_KINDS =
  /\b(word|docx?|pdf|power ?point|pptx?|slides?|slide ?deck|deck|presentation|excel|xlsx|spreadsheet|workbook|csv|chart|graph|plot|histogram|pie chart|bar chart|infographic|poster|flyer|brochure|certificate|cv|resume|résumé|cover letter|invoice|timetable|planner|downloadable|file)\b/i;

const IMAGE_EDIT =
  /\b(crop|resize|rotate|flip|compress|sharpen|blur|brighten|darken|contrast|saturat\w*|black and white|grayscale|greyscale|sepia|watermark|add text|caption|border|frame|collage|convert|png|jpe?g|webp|background|remove the background|make it (?:smaller|bigger|brighter|darker)|enhance|edit|adjust|filter)\b/i;

/** Websites and code delivered as files, not pasted into the reply. */
const CODE_FILES =
  /\b(as (?:a |real )?files|website files|site files|project files|source files|index\.html|style\.css|script\.js|\.py file|python file|html file|downloadable (?:website|site|app|project|code)|(?:website|site|web ?page|landing page|portfolio|web app) (?:i can|to) download|zip(?:ped)?|folder)\b/i;

const RUN_CODE =
  /\b(run|execute|test)\s+(?:this|the|my|that|these|it)\s*(?:python|javascript|js)?\s*(code|script|program|snippet|function|notebook)?\b(?=[\s\S]*(```|\bdef |\bimport |\bprint\(|console\.log|\bfunction\b))|\b(run|execute)\s+(?:this|the|my|that)\s+(?:python|javascript|js)?\s*(code|script|program)\b/i;

export interface FileIntentInput {
  message: string;
  /** Media types of the files attached to this message. */
  attachmentTypes: string[];
}

export function wantsFileOutput({ message, attachmentTypes }: FileIntentInput): boolean {
  const text = message.trim();
  if (!text) return false;

  // "Make me a PowerPoint on…", "turn these notes into a Word document",
  // "plot this data as a bar chart".
  if (MAKE.test(text) && FILE_KINDS.test(text)) return true;

  // "Give me my portfolio as files", "build me a website I can download",
  // "zip these up".
  if (MAKE.test(text) && CODE_FILES.test(text)) return true;
  if (/\b(zip|\.zip)\b/i.test(text)) return true;

  // "Run this code", "test my Python script": executed in the sandbox.
  if (RUN_CODE.test(text)) return true;

  // An attached image with an editing request: "crop this", "make it black and
  // white", "remove the background".
  const hasImage = attachmentTypes.some((t) => t.startsWith("image/"));
  if (hasImage && IMAGE_EDIT.test(text)) return true;

  // An attached spreadsheet with a request for a chart or a cleaned-up copy.
  const hasSheet = attachmentTypes.some(
    (t) => t.includes("spreadsheet") || t === "text/csv"
  );
  if (hasSheet && /\b(chart|graph|plot|clean|sort|filter|pivot|summari[sz]e)\b/i.test(text)) {
    return true;
  }

  return false;
}

/** Logos, icons and simple illustrations: drawn as SVG in an ordinary reply. */
export function wantsVectorArt(message: string): boolean {
  return (
    /\b(logo|icon|emblem|badge|monogram|wordmark|favicon|mascot|illustration|vector|svg|sticker|symbol)\b/i.test(message) &&
    /\b(make|create|generate|design|draw|sketch|give me|i need|can you)\b/i.test(message)
  );
}

/**
 * A follow-up that changes a file Astraeya has just made: "make the title
 * blue", "add a slide on costs", "change the colour to white". Only asked when
 * the previous reply produced a file, so "make it shorter" after an ordinary
 * answer stays an ordinary reply.
 */
export function wantsFileEdit(message: string): boolean {
  const text = message.trim();
  if (!text || text.length > 2000) return false;
  return /\b(change|make (?:it|the|them|this)|add|remove|delete|replace|update|edit|fix|swap|move|rename|instead|redo|again|another version|bigger|smaller|larger|bolder|darker|lighter|colou?rs?|fonts?|titles?|headings?|slides?|pages?|rows?|columns?|sheets?|tables?|charts?|logo|background|white|black|red|blue|green|yellow|orange|purple|gold|grey|gray)\b/i.test(
    text
  );
}
