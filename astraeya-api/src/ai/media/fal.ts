/**
 * The media service (fal.ai): image, logo and video models behind one key.
 *
 * Every request goes through fal's queue: submit, then poll the status URL it
 * hands back, then read the result. Images finish in seconds, so the tool
 * waits for them; videos take minutes, so a background job polls instead.
 *
 * Only the server talks to fal. Users never see a fal URL: results are
 * downloaded here and kept in Astraeya's own file store.
 */

import { env } from "../../env";

/** Which model does what, and what it costs, in one place. */
export const MEDIA_MODELS = {
  image: {
    id: "fal-ai/flux-2",
    // $0.012 per megapixel; a 1024x1024 image is 1.05 MP.
    microsPerMegapixel: 12_000,
  },
  imageEdit: {
    id: "fal-ai/flux-2/edit",
    // Billed on processed megapixels (input plus output), so about double.
    microsPerMegapixel: 12_000,
  },
  logo: {
    id: "fal-ai/recraft/v4/text-to-vector",
    microsPerImage: 80_000,
  },
  video: {
    textToVideo: "fal-ai/kling-video/v3/pro/text-to-video",
    imageToVideo: "fal-ai/kling-video/v3/pro/image-to-video",
    microsPerSecond: 140_000,
  },
} as const;

export function mediaServiceConfigured(): boolean {
  return Boolean(env.FAL_KEY);
}

/** A failure worth telling the user about, already in plain words. */
export class MediaServiceError extends Error {
  constructor(
    message: string,
    /** True when the service refused the content, not when it broke. */
    readonly blocked = false
  ) {
    super(message);
  }
}

export interface QueuedRequest {
  requestId: string;
  statusUrl: string;
  responseUrl: string;
}

export type QueueState = "queued" | "processing" | "done" | "failed";

function headers(): Record<string, string> {
  if (!env.FAL_KEY) throw new MediaServiceError("Image and video generation is not set up on this server.");
  return { Authorization: `Key ${env.FAL_KEY}`, "Content-Type": "application/json" };
}

/** Turns a fal error body into a sentence; the raw detail goes to the log. */
async function failure(res: Response, what: string): Promise<MediaServiceError> {
  const body = await res.text().catch(() => "");
  console.error(`[fal] ${what} failed: ${res.status} ${body.slice(0, 500)}`);
  const lower = body.toLowerCase();
  if (res.status === 401 || res.status === 403) {
    return new MediaServiceError("The image and video service rejected this server's key. This is a server problem, not something you did.");
  }
  if (res.status === 402 || lower.includes("balance") || lower.includes("exhausted")) {
    return new MediaServiceError("The image and video service has run out of credit. The account owner needs to top it up.");
  }
  if (res.status === 429) {
    return new MediaServiceError("The image and video service is busy. Try again in a minute.");
  }
  if (lower.includes("nsfw") || lower.includes("content policy") || lower.includes("safety")) {
    return new MediaServiceError("The image service's safety check refused this request.", true);
  }
  if (res.status === 422) {
    return new MediaServiceError("The image and video service could not use that request. Try describing it differently.");
  }
  return new MediaServiceError("The image and video service had a problem. Try again shortly.");
}

export async function submit(
  model: string,
  input: Record<string, unknown>,
  webhookUrl?: string
): Promise<QueuedRequest> {
  const url = new URL(`${env.FAL_QUEUE_URL}/${model}`);
  if (webhookUrl) url.searchParams.set("fal_webhook", webhookUrl);
  const res = await fetch(url, { method: "POST", headers: headers(), body: JSON.stringify(input) });
  if (!res.ok) throw await failure(res, `submit ${model}`);
  const body = (await res.json()) as { request_id?: string; status_url?: string; response_url?: string };
  if (!body.request_id || !body.status_url || !body.response_url) {
    throw new MediaServiceError("The image and video service gave an unexpected answer. Try again shortly.");
  }
  return { requestId: body.request_id, statusUrl: body.status_url, responseUrl: body.response_url };
}

export async function status(req: QueuedRequest): Promise<QueueState> {
  const res = await fetch(req.statusUrl, { headers: headers() });
  if (!res.ok) throw await failure(res, "status");
  const body = (await res.json()) as { status?: string; error?: unknown };
  switch (body.status) {
    case "IN_QUEUE":
      return "queued";
    case "IN_PROGRESS":
      return "processing";
    case "COMPLETED":
      // A completed request can still have failed; the result says which.
      return body.error ? "failed" : "done";
    default:
      return "failed";
  }
}

export async function result<T>(req: QueuedRequest): Promise<T> {
  const res = await fetch(req.responseUrl, { headers: headers() });
  if (!res.ok) throw await failure(res, "result");
  return (await res.json()) as T;
}

/** Submits and waits. For images, which take seconds. */
export async function run<T>(
  model: string,
  input: Record<string, unknown>,
  timeoutMs = 120_000
): Promise<T> {
  const req = await submit(model, input);
  const deadline = Date.now() + timeoutMs;
  let wait = 600;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(wait * 1.5, 3000);
    const state = await status(req);
    if (state === "done") return result<T>(req);
    if (state === "failed") {
      // The result endpoint carries the reason (often a safety refusal).
      const res = await fetch(req.responseUrl, { headers: headers() });
      throw await failure(res, `run ${model}`);
    }
  }
  throw new MediaServiceError("The image took too long to make. Try again.");
}

/** Downloads a result file, refusing anything larger than `maxBytes`. */
export async function download(url: string, maxBytes: number): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new MediaServiceError("The finished file could not be fetched. Try again.");
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new MediaServiceError("The finished file was too large to keep.");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > maxBytes) throw new MediaServiceError("The finished file was too large to keep.");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** fal accepts images inline as data URIs, so attachments never need a public URL. */
export function dataUri(mediaType: string, bytes: Buffer): string {
  return `data:${mediaType};base64,${bytes.toString("base64")}`;
}
