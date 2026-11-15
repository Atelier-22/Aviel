/**
 * Images, logos, image edits, AI videos and slideshow videos.
 *
 * Every path runs the same steps in the same order:
 *   1. limits: the feature is on, the daily count and daily spend allow it
 *   2. a safety check on the request, before anything is paid for
 *   3. generation at the media service (or locally, for slideshows)
 *   4. a safety check on what came out, before anyone sees it
 *   5. the bytes go into Astraeya's file store, the cost into the ledger
 *
 * A failure at any step ends there with a plain sentence for the user, and no
 * file. Nothing is ever reported as made unless the file exists.
 */

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { env } from "../env";
import type { MadeFile } from "../ai/provider.interface";
import { openStoredFile, putStoredFile } from "../ai/file-store";
import {
  MEDIA_MODELS,
  MediaServiceError,
  dataUri,
  download,
  mediaServiceConfigured,
  result,
  run,
  status,
  submit,
  type QueuedRequest,
} from "../ai/media/fal";
import { checkOutput, checkRequest } from "../ai/media/moderation";
import { renderSlideshow, renderSvgToPng, type AspectRatio, type Slide } from "../ai/media/slideshow";
import { sampleVideoFrames } from "../ai/visual-reader";
import { getPlatformConfig } from "../settings/platform";
import { checkLimit, type UsageType } from "./limits.service";
import { recordUsage } from "./chat.service";
import { safeFilename, toClientFile, type FileForClient } from "./files.service";

const MAX_IMAGE_BYTES = 20_000_000;
const MAX_VIDEO_BYTES = 100_000_000;

/** What a tool hands back to the model: a sentence, and whether it failed. */
export interface ToolOutcome {
  content: string;
  isError?: boolean;
}

/** A refusal or failure, already worded for the user. */
export class MediaRefusal extends Error {}

// ---------------------------------------------------------------------------
// Limits and the cost ledger
// ---------------------------------------------------------------------------

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function recordCost(userId: string, kind: string, model: string, costMicros: number, units = 1) {
  await db.insert(schema.costEvents).values({ userId, kind, model, units, costMicros: Math.round(costMicros) });
}

/** Spent today plus what running videos will cost when they finish. */
async function spendTodayMicros(userId: string): Promise<number> {
  const [spent] = await db
    .select({ total: sql<number>`coalesce(sum(${schema.costEvents.costMicros}), 0)::bigint` })
    .from(schema.costEvents)
    .where(and(eq(schema.costEvents.userId, userId), gte(schema.costEvents.createdAt, startOfToday())));
  const active = await db.query.mediaJobs.findMany({
    where: and(eq(schema.mediaJobs.userId, userId), inArray(schema.mediaJobs.status, ["queued", "processing"])),
    columns: { params: true, kind: true },
  });
  const pending = active.reduce(
    (sum, j) => sum + (j.kind === "video" ? Number(j.params.seconds ?? 5) * MEDIA_MODELS.video.microsPerSecond : 0),
    0
  );
  return Number(spent?.total ?? 0) + pending;
}

/** Throws a MediaRefusal with the reason when this generation is not allowed. */
async function ensureAllowed(userId: string, usage: UsageType, estimateMicros: number, needsService = true) {
  const config = await getPlatformConfig();
  if (!config.features.imageGeneration) {
    throw new MediaRefusal("Image and video generation has been turned off by the administrator.");
  }
  if (needsService && !mediaServiceConfigured()) {
    throw new MediaRefusal("Image and video generation is not set up on this server yet.");
  }
  const allowance = await checkLimit(userId, usage);
  if (!allowance.allowed) throw new MediaRefusal(allowance.message);
  const ceiling = config.limits.dailySpendCentsPerUser * 10_000;
  if (ceiling > 0 && (await spendTodayMicros(userId)) + estimateMicros > ceiling) {
    throw new MediaRefusal("You have reached today's generation budget. It resets at midnight.");
  }
}

async function ensureSafe(kind: Parameters<typeof checkRequest>[0], request: string, hasSource = false) {
  const verdict = await checkRequest(kind, request, hasSource);
  if (!verdict.allowed) {
    console.info(`[media] request refused (${verdict.category}): ${request.slice(0, 120)}`);
    throw new MediaRefusal(verdict.reason ?? "That isn't something I can make.");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** "A sunrise over Kampala, golden light" -> "sunrise-over-kampala-golden-light". */
export function slugFor(text: string, fallback: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !["a", "an", "the", "of", "for", "my", "me", "make", "create", "with", "and"].includes(w))
    .slice(0, 6)
    .join("-");
  return slug || fallback;
}

function megapixels(w: number, h: number) {
  return (w * h) / 1_000_000;
}

/** A width or height the image model accepts: 512–2048, a multiple of 16. */
function clampSide(n: unknown, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.round(Math.min(Math.max(v, 512), 2048) / 16) * 16;
}

function sniffImageType(bytes: Buffer): "image/png" | "image/jpeg" | "image/webp" | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return null;
}

async function store(bytes: Buffer, filename: string, mediaType: string): Promise<MadeFile> {
  const name = safeFilename(filename);
  const { providerFileId, sizeBytes } = await putStoredFile(bytes, name, mediaType);
  return { providerFileId, filename: name, mediaType, sizeBytes };
}

/** An image the user attached this turn, or one made earlier in the chat. */
export interface SourceImage {
  name: string;
  mediaType: string;
  bytes: Buffer;
}

export interface MediaContext {
  userId: string;
  conversationId: string;
  /** Images attached to this message. */
  attachments: { name: string; mediaType: string; base64: string }[];
  /** Hands a finished file to the chat, which records it under the reply. */
  emitFile: (file: MadeFile) => void;
  /** Tells the chat a slow job has started, so it can show progress. */
  emitJob: (jobId: string) => void;
}

/**
 * Finds the image a tool call refers to: by filename, else the newest one
 * attached this turn, else the newest one made in this conversation.
 */
export async function findSourceImage(ctx: MediaContext, ref?: string): Promise<SourceImage | null> {
  const wanted = ref?.trim().toLowerCase() || null;
  const attached = ctx.attachments.filter((a) => a.mediaType.startsWith("image/"));
  const attachment = wanted ? attached.find((a) => a.name.toLowerCase() === wanted) : attached[attached.length - 1];
  if (attachment) {
    return { name: attachment.name, mediaType: attachment.mediaType, bytes: Buffer.from(attachment.base64, "base64") };
  }

  const made = await db.query.generatedFiles.findMany({
    where: and(
      eq(schema.generatedFiles.userId, ctx.userId),
      eq(schema.generatedFiles.conversationId, ctx.conversationId),
      inArray(schema.generatedFiles.mediaType, ["image/png", "image/jpeg", "image/webp"])
    ),
    orderBy: [desc(schema.generatedFiles.createdAt)],
    limit: 50,
  });
  const row = wanted ? made.find((f) => f.filename.toLowerCase() === wanted) : made[0];
  if (!row) return null;
  const res = await openStoredFile(row.providerFileId);
  return { name: row.filename, mediaType: row.mediaType, bytes: Buffer.from(await res.arrayBuffer()) };
}

/** Runs a tool body, turning refusals and failures into an honest result. */
export async function asOutcome(work: () => Promise<string>): Promise<ToolOutcome> {
  try {
    return { content: await work() };
  } catch (err) {
    if (err instanceof MediaRefusal || err instanceof MediaServiceError) {
      return {
        isError: true,
        content: `Not made: ${err.message} Tell the user this plainly, in your own words. Do not say or imply that anything was created.`,
      };
    }
    console.error("[media] tool failed:", err);
    return {
      isError: true,
      content: "Not made: something went wrong while making it. Tell the user it failed and that they can try again. Do not say or imply that anything was created.",
    };
  }
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

type FalImages = { images?: { url: string; content_type?: string; width?: number; height?: number }[]; has_nsfw_concepts?: boolean[] };

/** Checks, stores and hands over generated images. Returns their filenames. */
async function deliverImages(
  ctx: MediaContext,
  kind: "image" | "image_edit",
  request: string,
  out: FalImages,
  baseName: string
): Promise<string[]> {
  const images = out.images ?? [];
  if (images.length === 0) throw new MediaServiceError("The image service returned nothing. Try again.");
  if (out.has_nsfw_concepts?.some(Boolean)) {
    throw new MediaRefusal("The finished image did not pass the safety check, so it was not delivered.");
  }
  const downloaded = await Promise.all(images.map((img) => download(img.url, MAX_IMAGE_BYTES)));
  const typed = downloaded.map((bytes) => ({ bytes, mediaType: sniffImageType(bytes) ?? "image/png" }));
  const verdict = await checkOutput(kind, request, typed.map((t) => ({ mediaType: t.mediaType, base64: t.bytes.toString("base64") })));
  if (!verdict.allowed) {
    throw new MediaRefusal("The finished image did not pass the safety check, so it was not delivered.");
  }
  const names: string[] = [];
  for (let i = 0; i < typed.length; i++) {
    const ext = typed[i].mediaType === "image/jpeg" ? "jpg" : typed[i].mediaType === "image/webp" ? "webp" : "png";
    const file = await store(typed[i].bytes, `${baseName}${typed.length > 1 ? `-${i + 1}` : ""}.${ext}`, typed[i].mediaType);
    ctx.emitFile(file);
    names.push(file.filename);
  }
  return names;
}

const STYLE_HINTS: Record<string, string> = {
  photo: "photorealistic photograph, natural light, high detail",
  illustration: "clean digital illustration",
  cartoon: "friendly cartoon style, bold outlines, bright colours",
  poster: "graphic poster design, strong typography, balanced layout",
  watercolor: "soft watercolour painting",
  "3d": "3D render, soft studio lighting",
  minimal: "minimal flat design, plenty of empty space",
};

export async function generateImage(
  ctx: MediaContext,
  input: { prompt: string; width?: number; height?: number; style?: string; count?: number }
): Promise<string> {
  const prompt = input.prompt?.trim();
  if (!prompt) throw new MediaRefusal("No description was given for the image.");
  const width = clampSide(input.width, 1024);
  const height = clampSide(input.height, 1024);
  const count = Math.min(Math.max(Math.round(input.count ?? 1), 1), 4);
  const estimate = megapixels(width, height) * MEDIA_MODELS.image.microsPerMegapixel * count;

  await ensureAllowed(ctx.userId, "image", estimate);
  await ensureSafe("image", prompt);

  const style = input.style && STYLE_HINTS[input.style] ? `, ${STYLE_HINTS[input.style]}` : "";
  const out = await run<FalImages>(MEDIA_MODELS.image.id, {
    prompt: prompt + style,
    image_size: { width, height },
    num_images: count,
    output_format: "png",
    enable_safety_checker: true,
  });
  const names = await deliverImages(ctx, "image", prompt, out, slugFor(prompt, "image"));

  for (let i = 0; i < names.length; i++) await recordUsage(ctx.userId, "image");
  await recordCost(ctx.userId, "image", MEDIA_MODELS.image.id, estimate, names.length);

  return `Made ${names.length} image${names.length > 1 ? "s" : ""}: ${names.join(", ")} (${width}x${height}). The user sees ${
    names.length > 1 ? "them" : "it"
  } under your reply with Download, Share and Regenerate buttons. In one or two sentences say what you made and offer a change. Do not describe links or paste the image.`;
}

export async function editImage(ctx: MediaContext, input: { instruction: string; image?: string }): Promise<string> {
  const instruction = input.instruction?.trim();
  if (!instruction) throw new MediaRefusal("No change was described for the image.");
  const source = await findSourceImage(ctx, input.image);
  if (!source) {
    throw new MediaRefusal(
      input.image
        ? `There is no image called "${input.image}" in this conversation.`
        : "There is no image in this conversation to edit. Ask the user to attach one."
    );
  }
  if (source.bytes.length > 10_000_000) throw new MediaRefusal("That image is too large to edit. Try one under 10 MB.");
  const estimate = 2.2 * MEDIA_MODELS.imageEdit.microsPerMegapixel;

  await ensureAllowed(ctx.userId, "image", estimate);
  await ensureSafe("image_edit", instruction, true);

  const out = await run<FalImages>(MEDIA_MODELS.imageEdit.id, {
    prompt: instruction,
    image_urls: [dataUri(source.mediaType, source.bytes)],
    output_format: "png",
    enable_safety_checker: true,
  });
  const base = source.name.replace(/\.[^.]+$/, "") + "-edited";
  const names = await deliverImages(ctx, "image_edit", instruction, out, base);

  await recordUsage(ctx.userId, "image");
  await recordCost(ctx.userId, "image_edit", MEDIA_MODELS.imageEdit.id, estimate);
  return `Edited "${source.name}" and made ${names.join(", ")}. It is shown under your reply with Download, Share and Regenerate buttons. Say briefly what changed.`;
}

// ---------------------------------------------------------------------------
// Logos: a real vector, plus a PNG of it
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Strips anything executable from an SVG before it is stored. */
export function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, "")
    .replace(/(href\s*=\s*["'])\s*javascript:[^"']*/gi, "$1#");
}

export async function generateLogo(
  ctx: MediaContext,
  input: { brand_name: string; description: string; colors?: string[]; background?: string }
): Promise<string> {
  const name = input.brand_name?.trim();
  const description = input.description?.trim();
  if (!name || !description) throw new MediaRefusal("A logo needs a name and a short description.");
  const estimate = MEDIA_MODELS.logo.microsPerImage;

  await ensureAllowed(ctx.userId, "image", estimate);
  const prompt = `A professional logo for "${name}": ${description}. Clean vector logo, centred, simple shapes, legible wordmark reading exactly "${name}", no mockup, no extra text.`;
  await ensureSafe("logo", prompt);

  const colors = (input.colors ?? []).map(hexToRgb).filter(Boolean).slice(0, 5);
  const background = input.background ? hexToRgb(input.background) : { r: 255, g: 255, b: 255 };
  const out = await run<FalImages>(MEDIA_MODELS.logo.id, {
    prompt,
    image_size: "square_hd",
    ...(colors.length ? { colors } : {}),
    ...(background ? { background_color: background } : {}),
    enable_safety_checker: true,
  });
  const url = out.images?.[0]?.url;
  if (!url) throw new MediaServiceError("The logo service returned nothing. Try again.");

  const svg = sanitizeSvg((await download(url, 5_000_000)).toString("utf8"));
  if (!svg.includes("<svg")) throw new MediaServiceError("The logo came back in a form that could not be used. Try again.");
  const png = renderSvgToPng(svg, 1024);

  const verdict = await checkOutput("logo", prompt, [{ mediaType: "image/png", base64: png.toString("base64") }]);
  if (!verdict.allowed) throw new MediaRefusal("The finished logo did not pass the safety check, so it was not delivered.");

  const base = `${slugFor(name, "logo")}-logo`;
  const pngFile = await store(png, `${base}.png`, "image/png");
  const svgFile = await store(Buffer.from(svg, "utf8"), `${base}.svg`, "image/svg+xml");
  ctx.emitFile(pngFile);
  ctx.emitFile(svgFile);

  await recordUsage(ctx.userId, "image");
  await recordCost(ctx.userId, "logo", MEDIA_MODELS.logo.id, estimate);
  return `Made the logo for "${name}" as ${pngFile.filename} (preview, 1024px) and ${svgFile.filename} (vector, scales to any size). Both are under your reply with Download and Share. In one or two sentences describe the idea and offer changes (colours, layout, icon).`;
}

// ---------------------------------------------------------------------------
// Video jobs
// ---------------------------------------------------------------------------

type JobRow = typeof schema.mediaJobs.$inferSelect;

export interface JobForClient {
  id: string;
  kind: string;
  status: string;
  prompt: string;
  error: string | null;
  createdAt: string;
  file: FileForClient | null;
}

export async function jobForClient(job: JobRow): Promise<JobForClient> {
  let file: FileForClient | null = null;
  if (job.fileId) {
    const row = await db.query.generatedFiles.findFirst({ where: eq(schema.generatedFiles.id, job.fileId) });
    if (row) file = toClientFile(row);
  }
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    prompt: job.prompt,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    file,
  };
}

const ASPECTS = new Set(["16:9", "9:16", "1:1"]);

export async function startVideo(
  ctx: MediaContext,
  input: { prompt: string; duration_seconds?: number; aspect_ratio?: string; start_image?: string; voiceover_text?: string }
): Promise<string> {
  const prompt = input.prompt?.trim();
  if (!prompt) throw new MediaRefusal("No description was given for the video.");
  const config = await getPlatformConfig();
  const max = config.limits.maxVideoSeconds;
  const asked = Math.round(input.duration_seconds ?? 5);
  const seconds = Math.min(Math.max(asked, 3), max);
  const aspect = ASPECTS.has(input.aspect_ratio ?? "") ? input.aspect_ratio! : "16:9";
  const voiceover = input.voiceover_text?.trim().slice(0, 400);

  await ensureAllowed(ctx.userId, "video", seconds * MEDIA_MODELS.video.microsPerSecond);
  const source = input.start_image ? await findSourceImage(ctx, input.start_image) : null;
  if (input.start_image && !source) throw new MediaRefusal(`There is no image called "${input.start_image}" in this conversation.`);
  await ensureSafe("video", voiceover ? `${prompt}\nVoiceover: "${voiceover}"` : prompt, Boolean(source));

  const [job] = await db
    .insert(schema.mediaJobs)
    .values({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      kind: "video",
      model: source ? MEDIA_MODELS.video.imageToVideo : MEDIA_MODELS.video.textToVideo,
      prompt,
      params: {
        seconds,
        aspect,
        voiceover: voiceover ?? null,
        // Kept only until submission; cleared after.
        startImage: source ? dataUri(source.mediaType, source.bytes) : null,
      },
    })
    .returning();
  await recordUsage(ctx.userId, "video");
  ctx.emitJob(job.id);
  kickWorker();

  const clamped = asked > max ? ` (they asked for ${asked} seconds; the current maximum is ${max})` : "";
  return `Video job started: ${seconds} seconds, ${aspect}${clamped}. Job id: ${job.id}. It takes a few minutes. The user sees a progress card under your reply that turns into a player with Download and Share when it is ready, and gets a notification if they leave the page. Tell them it is being made and roughly how long; do not claim it is finished. Use get_video_status only if they ask about progress.`;
}

export async function startSlideshow(
  ctx: MediaContext,
  input: {
    title?: string;
    slides: { heading?: string; text?: string; image_prompt?: string }[];
    aspect_ratio?: string;
    seconds_per_slide?: number;
    colors?: string[];
  }
): Promise<string> {
  const slides = (input.slides ?? []).filter((s) => s.heading?.trim() || s.text?.trim()).slice(0, 15);
  if (slides.length === 0) throw new MediaRefusal("A slideshow needs at least one slide with some text.");
  const pictures = slides.filter((s) => s.image_prompt?.trim()).length;
  if (pictures > 0 && !mediaServiceConfigured()) {
    throw new MediaRefusal("Pictures for slides need image generation, which is not set up on this server. Offer the slideshow with text only.");
  }
  await ensureAllowed(ctx.userId, "video", pictures * MEDIA_MODELS.image.microsPerMegapixel, pictures > 0);
  const text = slides.map((s, i) => `${i + 1}. ${s.heading ?? ""} — ${s.text ?? ""}${s.image_prompt ? ` [picture: ${s.image_prompt}]` : ""}`).join("\n");
  await ensureSafe("slideshow", `${input.title ?? ""}\n${text}`);

  const [job] = await db
    .insert(schema.mediaJobs)
    .values({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      kind: "slideshow",
      model: "ffmpeg",
      prompt: input.title?.trim() || slides[0].heading?.trim() || "Slideshow",
      params: {
        slides,
        aspect: ASPECTS.has(input.aspect_ratio ?? "") ? input.aspect_ratio : "16:9",
        secondsPerSlide: Math.min(Math.max(input.seconds_per_slide ?? 4, 2), 10),
        colors: (input.colors ?? []).filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 2),
      },
    })
    .returning();
  await recordUsage(ctx.userId, "video");
  ctx.emitJob(job.id);
  kickWorker();
  return `Slideshow video started (${slides.length} slides${pictures ? `, ${pictures} with pictures` : ""}). Job id: ${job.id}. It is usually ready within a minute; the user sees a progress card that becomes a player with Download and Share. Tell them it is being made. Do not claim it is finished.`;
}

export async function videoStatus(userId: string, jobId: string): Promise<string> {
  const job = await db.query.mediaJobs.findFirst({
    where: and(eq(schema.mediaJobs.id, jobId), eq(schema.mediaJobs.userId, userId)),
  });
  if (!job) return "No video job with that id belongs to this user.";
  if (job.status === "done") return "done: the video is ready and shown in the chat with a player, Download and Share.";
  if (job.status === "failed") return `failed: ${job.error ?? "unknown reason"}. Nothing was delivered.`;
  const minutes = Math.round((Date.now() - job.createdAt.getTime()) / 60000);
  return `${job.status}: started ${minutes} minute${minutes === 1 ? "" : "s"} ago, not finished yet.`;
}

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

const JOB_TIMEOUT_MS = 20 * 60 * 1000;
/** A job made this turn waits briefly for its reply to be saved, so the file lands under it. */
const REPLY_GRACE_MS = 45 * 1000;

async function updateJob(id: string, patch: Partial<JobRow>) {
  await db.update(schema.mediaJobs).set({ ...patch, updatedAt: new Date() }).where(eq(schema.mediaJobs.id, id));
}

async function fail(job: JobRow, message: string) {
  console.info(`[media] job ${job.id} failed: ${message}`);
  await updateJob(job.id, { status: "failed", error: message, params: { ...job.params, startImage: null } });
}

function readyToDeliver(job: JobRow) {
  return Boolean(job.messageId) || Date.now() - job.createdAt.getTime() > REPLY_GRACE_MS;
}

async function finishWithFile(job: JobRow, file: MadeFile) {
  const [row] = await db
    .insert(schema.generatedFiles)
    .values({
      userId: job.userId,
      conversationId: job.conversationId,
      messageId: job.messageId,
      providerFileId: file.providerFileId,
      filename: file.filename,
      mediaType: file.mediaType,
      sizeBytes: file.sizeBytes,
    })
    .returning();
  await updateJob(job.id, { status: "done", fileId: row.id, error: null, params: { ...job.params, startImage: null } });
}

async function checkFrames(job: JobRow, mp4: Buffer, kind: "video" | "slideshow"): Promise<boolean> {
  const { frames } = await sampleVideoFrames(mp4.toString("base64"), "mp4");
  const pick = frames.filter((_, i) => i % Math.ceil(frames.length / 5) === 0).slice(0, 5);
  const verdict = await checkOutput(kind, job.prompt, pick.map((f) => ({ mediaType: "image/jpeg" as const, base64: f.data })));
  return verdict.allowed;
}

function webhookUrl(jobId: string): string | undefined {
  if (!env.PUBLIC_API_URL) return undefined;
  return `${env.PUBLIC_API_URL.replace(/\/$/, "")}/media/webhook/${jobId}`;
}

async function advanceVideo(job: JobRow, canStart: boolean) {
  const p = job.params as {
    seconds: number;
    aspect: string;
    voiceover: string | null;
    startImage: string | null;
    queue?: QueuedRequest;
  };

  if (job.status === "queued") {
    if (!canStart) return;
    const prompt = p.voiceover ? `${job.prompt}. A warm narrator's voice says: "${p.voiceover}"` : job.prompt;
    const input: Record<string, unknown> = {
      prompt,
      duration: String(p.seconds),
      generate_audio: true,
      negative_prompt: "blur, distort, low quality, watermark, text artifacts",
      enable_safety_checker: true,
      ...(p.startImage ? { start_image_url: p.startImage } : { aspect_ratio: p.aspect }),
    };
    const claimed = await db
      .update(schema.mediaJobs)
      .set({ status: "processing", updatedAt: new Date() })
      .where(and(eq(schema.mediaJobs.id, job.id), eq(schema.mediaJobs.status, "queued")))
      .returning({ id: schema.mediaJobs.id });
    if (claimed.length === 0) return;
    const queue = await submit(job.model, input, webhookUrl(job.id));
    await updateJob(job.id, {
      status: "processing",
      providerRequestId: queue.requestId,
      params: { ...p, startImage: null, queue },
    });
    return;
  }

  if (!p.queue) return fail(job, "The video could not be tracked. Try again.");
  const state = await status(p.queue);
  if (state === "queued" || state === "processing") return;
  if (state === "failed") {
    const res = await fetch(p.queue.responseUrl, { headers: { Authorization: `Key ${env.FAL_KEY}` } }).catch(() => null);
    const body = res ? await res.text().catch(() => "") : "";
    const blocked = /nsfw|safety|policy|content/i.test(body);
    return fail(job, blocked ? "The video service's safety check refused this video." : "The video service could not make this video. Try again, perhaps with a simpler description.");
  }
  if (!readyToDeliver(job)) return;

  const out = await result<{ video?: { url: string } }>(p.queue);
  if (!out.video?.url) return fail(job, "The video service returned no video. Try again.");
  const mp4 = await download(out.video.url, MAX_VIDEO_BYTES);
  if (!(await checkFrames(job, mp4, "video"))) {
    return fail(job, "The finished video did not pass the safety check, so it was not delivered.");
  }
  const file = await store(mp4, `${slugFor(job.prompt, "video")}.mp4`, "video/mp4");
  await finishWithFile(job, file);
  await recordCost(job.userId, "video", job.model, p.seconds * MEDIA_MODELS.video.microsPerSecond, p.seconds);
}

async function runSlideshow(job: JobRow) {
  if (!readyToDeliver(job)) return;
  const p = job.params as {
    slides: { heading?: string; text?: string; image_prompt?: string }[];
    aspect: AspectRatio;
    secondsPerSlide: number;
    colors: string[];
  };
  // Pictures need the media service; an instance without it leaves the job
  // for one that has it (the timeout still ends it if none does).
  if (p.slides.some((sl) => sl.image_prompt?.trim()) && !mediaServiceConfigured()) return;
  // Claimed in one statement, so two workers never render the same job.
  const claimed = await db
    .update(schema.mediaJobs)
    .set({ status: "processing", updatedAt: new Date() })
    .where(and(eq(schema.mediaJobs.id, job.id), eq(schema.mediaJobs.status, "queued")))
    .returning({ id: schema.mediaJobs.id });
  if (claimed.length === 0) return;

  const slides: Slide[] = [];
  let pictureCost = 0;
  const [w, h] = p.aspect === "9:16" ? [720, 1280] : p.aspect === "1:1" ? [1024, 1024] : [1280, 720];
  for (const s of p.slides) {
    const slide: Slide = { heading: s.heading, text: s.text };
    if (s.image_prompt?.trim()) {
      const out = await run<FalImages>(MEDIA_MODELS.image.id, {
        prompt: `${s.image_prompt}, no text, no words`,
        image_size: { width: clampSide(w, 1280), height: clampSide(h, 720) },
        output_format: "jpeg",
        enable_safety_checker: true,
      });
      const url = out.images?.[0]?.url;
      if (url && !out.has_nsfw_concepts?.some(Boolean)) {
        const bytes = await download(url, MAX_IMAGE_BYTES);
        slide.image = { mediaType: sniffImageType(bytes) ?? "image/jpeg", bytes };
        pictureCost += megapixels(w, h) * MEDIA_MODELS.image.microsPerMegapixel;
      }
    }
    slides.push(slide);
  }

  const palette: [string, string] | undefined = p.colors.length === 2 ? [p.colors[0], p.colors[1]] : undefined;
  const { mp4, framesPng } = await renderSlideshow({ slides, aspectRatio: p.aspect, secondsPerSlide: p.secondsPerSlide, palette });

  if (pictureCost > 0) {
    // Only pictures can carry something the text check did not see.
    const verdict = await checkOutput(
      "slideshow",
      job.prompt,
      framesPng.slice(0, 6).map((f) => ({ mediaType: "image/png" as const, base64: f.toString("base64") }))
    );
    if (!verdict.allowed) return fail(job, "The finished slideshow did not pass the safety check, so it was not delivered.");
    await recordCost(job.userId, "slideshow", MEDIA_MODELS.image.id, pictureCost, slides.filter((s) => s.image).length);
  }
  const file = await store(mp4, `${slugFor(job.prompt, "slideshow")}.mp4`, "video/mp4");
  await finishWithFile(job, file);
}

let ticking = false;
let pendingKick = false;

/** One pass over unfinished jobs. Safe to call often; passes never overlap. */
export async function tickJobs(): Promise<void> {
  if (ticking) {
    pendingKick = true;
    return;
  }
  ticking = true;
  try {
    const config = await getPlatformConfig();
    const open = await db.query.mediaJobs.findMany({
      where: inArray(schema.mediaJobs.status, ["queued", "processing"]),
      orderBy: [schema.mediaJobs.createdAt],
      limit: 50,
    });
    let running = open.filter((j) => j.kind === "video" && j.status === "processing").length;

    for (const job of open) {
      try {
        if (Date.now() - job.createdAt.getTime() > JOB_TIMEOUT_MS) {
          await fail(job, "The video took too long and was stopped. Try again.");
          continue;
        }
        if (job.kind === "slideshow") {
          // A render left half-done by a restart starts again.
          if (job.status === "processing" && Date.now() - job.updatedAt.getTime() > 5 * 60 * 1000) {
            await updateJob(job.id, { status: "queued" });
            continue;
          }
          if (job.status === "queued") await runSlideshow(job);
        } else if (job.kind === "video") {
          // Another instance with the key may own it; the timeout above
          // still ends it if none does.
          if (!mediaServiceConfigured()) continue;
          const canStart = running < config.limits.maxConcurrentVideos;
          const wasQueued = job.status === "queued";
          await advanceVideo(job, canStart);
          if (wasQueued && canStart) running++;
        }
      } catch (err) {
        const attempts = job.attempts + 1;
        console.error(`[media] job ${job.id} attempt ${attempts}:`, err instanceof Error ? err.message : err);
        if (err instanceof MediaServiceError || err instanceof MediaRefusal || attempts >= 5) {
          await fail(job, err instanceof Error && (err instanceof MediaServiceError || err instanceof MediaRefusal) ? err.message : "Making the video failed. Try again.");
        } else {
          await updateJob(job.id, { attempts });
        }
      }
    }
  } finally {
    ticking = false;
    if (pendingKick) {
      pendingKick = false;
      setImmediate(() => void tickJobs());
    }
  }
}

export function kickWorker() {
  setImmediate(() => void tickJobs().catch((err) => console.error("[media] worker:", err)));
}

let timer: NodeJS.Timeout | null = null;

export function startMediaWorker(intervalMs = 8000) {
  if (timer) return;
  timer = setInterval(() => void tickJobs().catch((err) => console.error("[media] worker:", err)), intervalMs);
  timer.unref();
  kickWorker();
}

export function stopMediaWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Ties this turn's jobs to the saved reply, so their videos land under it. */
export async function attachJobsToMessage(jobIds: string[], messageId: string) {
  if (jobIds.length === 0) return;
  await db.update(schema.mediaJobs).set({ messageId }).where(inArray(schema.mediaJobs.id, jobIds));
  kickWorker();
}

/** Jobs under each reply of a conversation, for the chat on reload. */
export async function jobsByMessage(userId: string, conversationId: string): Promise<Record<string, JobForClient[]>> {
  const rows = await db.query.mediaJobs.findMany({
    where: and(eq(schema.mediaJobs.userId, userId), eq(schema.mediaJobs.conversationId, conversationId)),
    orderBy: [schema.mediaJobs.createdAt],
  });
  const out: Record<string, JobForClient[]> = {};
  for (const row of rows) {
    if (!row.messageId) continue;
    (out[row.messageId] ??= []).push(await jobForClient(row));
  }
  return out;
}

export async function findOwnedJob(jobId: string, userId: string) {
  return (
    (await db.query.mediaJobs.findFirst({
      where: and(eq(schema.mediaJobs.id, jobId), eq(schema.mediaJobs.userId, userId)),
    })) ?? null
  );
}
