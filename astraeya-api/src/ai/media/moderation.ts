/**
 * The safety check every generation passes through, twice: on the request
 * before anything is paid for, and on the finished picture or video frames
 * before anyone sees it.
 *
 * It fails closed. If the check itself cannot run, nothing is generated or
 * delivered, and the user is told why.
 */

import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../env";

const CHECK_MODEL = "claude-haiku-5-5";

export interface ModerationVerdict {
  allowed: boolean;
  /** A short, plain sentence for the user when refused. */
  reason?: string;
  category?: string;
}

const POLICY = `You are the safety check for an assistant that generates images, logos and videos for its users. Users may ask for things for themselves or for someone else (a birthday video for a friend, a poster for a client); that is normal and allowed.

REFUSE when the request or output involves any of:
1. minors: any sexual, sexualised or suggestive content involving anyone who is or appears under 18. Always refuse.
2. sexual: explicit sexual content or nudity of anyone.
3. real_person_harm: sexual, violent, humiliating or defamatory depictions of a real, identifiable person.
4. deepfake: a realistic (photographic or video) depiction of a real, identifiable public figure or named real person doing or saying something, or a realistic imitation of their voice. Cartoons, caricature-free illustrations of historical figures for education, and the user's own uploaded photo edited in a harmless way are fine.
5. deception: fake news footage, fake official documents, IDs, passports, certificates, banknotes, receipts or screenshots meant to pass as genuine; impersonating a real organisation's branding to deceive.
6. violence: graphic gore, or content that promotes terrorism, self-harm or attacks.
7. hate: content that demeans people for a protected characteristic.

ALLOW everything else, including: logos and posters for businesses, celebration videos, fictional characters, landscapes and cities, stylised or cartoon people, school presentations, a friend named only by first name (they are not a public figure), and harmless edits of a photo the user supplied.

Answer with one line of JSON and nothing else:
{"allowed": true}
or
{"allowed": false, "category": "<one of the categories above>", "reason": "<one short sentence to the user, kind and plain, no lecturing>"}`;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return client;
}

const CHECK_FAILED: ModerationVerdict = {
  allowed: false,
  category: "check_failed",
  reason: "The safety check could not run just now, so nothing was made. Try again in a moment.",
};

function parse(text: string): ModerationVerdict {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return CHECK_FAILED;
  try {
    const v = JSON.parse(match[0]) as { allowed?: unknown; reason?: unknown; category?: unknown };
    if (v.allowed === true) return { allowed: true };
    if (v.allowed === false) {
      return {
        allowed: false,
        category: typeof v.category === "string" ? v.category : "policy",
        reason: typeof v.reason === "string" && v.reason.trim() ? v.reason.trim() : "That isn't something I can make.",
      };
    }
  } catch {
    /* fall through */
  }
  return CHECK_FAILED;
}

async function check(content: Anthropic.ContentBlockParam[]): Promise<ModerationVerdict> {
  if (!env.ANTHROPIC_API_KEY) return CHECK_FAILED;
  try {
    const message = await getClient().messages.create({
      model: CHECK_MODEL,
      max_tokens: 200,
      system: POLICY,
      messages: [{ role: "user", content }],
    });
    // A refusal from the checker itself is a refusal of the content.
    if (message.stop_reason === "refusal") {
      return { allowed: false, category: "policy", reason: "That isn't something I can make." };
    }
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return parse(text);
  } catch (err) {
    console.error("Moderation check failed:", err instanceof Error ? err.message : err);
    return CHECK_FAILED;
  }
}

/** Before generating: is this request acceptable? */
export function checkRequest(kind: "image" | "logo" | "image_edit" | "video" | "slideshow", request: string, hasSourceImage = false) {
  return check([
    {
      type: "text",
      text: `Request type: ${kind}${hasSourceImage ? " (editing or animating an image the user supplied)" : ""}\n\nThe request:\n"""\n${request.slice(0, 6000)}\n"""`,
    },
  ]);
}

type ImageType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/** After generating: is what came out acceptable? */
export function checkOutput(
  kind: "image" | "logo" | "image_edit" | "video" | "slideshow",
  request: string,
  images: { mediaType: ImageType; base64: string }[]
) {
  return check([
    ...images.slice(0, 6).map((img) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: img.mediaType, data: img.base64 },
    })),
    {
      type: "text",
      text: `These are ${kind === "video" || kind === "slideshow" ? "frames from a finished video" : "the finished output"}, made for this request: "${request.slice(0, 2000)}". Judge what is actually shown.`,
    },
  ]);
}
