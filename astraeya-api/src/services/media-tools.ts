/**
 * The tools the assistant can call to make pictures and video. Each has a
 * name, a description the model reads to decide when to use it, a JSON
 * schema for its input, and a handler that runs here on the server.
 *
 * Handlers never throw: a refusal or failure comes back as an error result
 * that tells the model to say so plainly, so a failed generation can never be
 * presented as a finished one.
 */

import type { ClientTool, StreamChunk } from "../ai/provider.interface";
import {
  asOutcome,
  editImage,
  generateImage,
  generateLogo,
  startSlideshow,
  startVideo,
  videoStatus,
  type MediaContext,
} from "./media.service";

export interface MediaToolBase {
  userId: string;
  conversationId: string;
  attachments: { name: string; mediaType: string; base64: string }[];
}

export interface MediaToolOptions {
  /** Images, logos, edits and AI video: needs the media service. */
  generation: boolean;
  /** Slideshow videos: rendered here, available whenever tools are. */
  slideshow: boolean;
  maxVideoSeconds: number;
}

function context(base: MediaToolBase, emit: (chunk: StreamChunk) => void): MediaContext {
  return {
    ...base,
    emitFile: (file) => emit({ type: "file", file }),
    emitJob: (jobId) => emit({ type: "job", jobId }),
  };
}

const str = (description: string) => ({ type: "string", description });

export function buildMediaTools(base: MediaToolBase, opts: MediaToolOptions): ClientTool[] {
  const tools: ClientTool[] = [];

  if (opts.generation) {
    tools.push(
      {
        name: "generate_image",
        description:
          "Create pictures from a description: photos, illustrations, posters, cards, flyers, artwork, backgrounds. Use for any request to make, draw or design an image, for the user or for someone else. Write a rich, specific prompt (subject, setting, style, lighting, composition, any exact text to show). For logos and icons use generate_logo instead. Returns PNG files shown in the chat.",
        status: "Making your image…",
        inputSchema: {
          type: "object",
          properties: {
            prompt: str("Detailed description of the image. Include any exact words to appear on it in quotes."),
            width: { type: "integer", description: "Pixels, 512–2048. 1024 by default. Use 1024x1536 for portrait posters, 1536x1024 for landscape.", minimum: 512, maximum: 2048 },
            height: { type: "integer", description: "Pixels, 512–2048. 1024 by default.", minimum: 512, maximum: 2048 },
            style: { type: "string", enum: ["photo", "illustration", "cartoon", "poster", "watercolor", "3d", "minimal"], description: "Optional overall style." },
            count: { type: "integer", minimum: 1, maximum: 4, description: "How many variations. 1 unless the user asks for options." },
          },
          required: ["prompt"],
        },
        run: (input, emit) => asOutcome(() => generateImage(context(base, emit), input as never)),
      },
      {
        name: "edit_image",
        description:
          "Change an existing image: one the user attached, or one made earlier in this conversation. Use for 'make the sky purple', 'add a hat', 'remove the person on the left', 'turn this photo into a cartoon'. Simple crops, resizes and filters can be done with code instead when a code sandbox is available.",
        status: "Editing your image…",
        inputSchema: {
          type: "object",
          properties: {
            instruction: str("The change to make, stated precisely."),
            image: str("Filename of the image to edit. Leave out to use the most recent image in the conversation."),
          },
          required: ["instruction"],
        },
        run: (input, emit) => asOutcome(() => editImage(context(base, emit), input as never)),
      },
      {
        name: "generate_logo",
        description:
          "Design a logo, icon, emblem or badge as a real vector. Returns a PNG preview and an SVG that scales to any size. Use whenever the user asks for a logo or brand mark, for themselves or a client. If they have not given a name, use the one from the conversation or ask briefly.",
        status: "Designing your logo…",
        inputSchema: {
          type: "object",
          properties: {
            brand_name: str("The exact name to appear in the logo."),
            description: str("What the business or project is, the feeling wanted, and any icon idea, e.g. 'coffee roastery in Kampala, warm and modern, a coffee bean shaped like the sun'."),
            colors: { type: "array", items: { type: "string" }, description: "Up to 5 hex colours, e.g. #0F766E.", maxItems: 5 },
            background: str("Hex background colour. White by default."),
          },
          required: ["brand_name", "description"],
        },
        run: (input, emit) => asOutcome(() => generateLogo(context(base, emit), input as never)),
      },
      {
        name: "generate_video",
        description: `Start making a short AI video (3–${opts.maxVideoSeconds} seconds) from a description, optionally starting from an image in the conversation and with a spoken line. Use for 'make a video of…', birthday or celebration clips, short scenes. It runs in the background for a few minutes; the chat shows progress and then a player. For presentations, explainers or anything mostly text, prefer make_slideshow_video, which is quicker and cheaper.`,
        status: "Starting your video…",
        inputSchema: {
          type: "object",
          properties: {
            prompt: str("A vivid description of the scene and motion: subject, action, setting, camera movement, mood, lighting."),
            duration_seconds: { type: "integer", minimum: 3, maximum: opts.maxVideoSeconds, description: `Length in seconds, at most ${opts.maxVideoSeconds}. 5 by default.` },
            aspect_ratio: { type: "string", enum: ["16:9", "9:16", "1:1"], description: "16:9 for screens, 9:16 for phone stories and status, 1:1 for posts." },
            start_image: str("Filename of an image in the conversation to animate from. Optional."),
            voiceover_text: str("A short line to be spoken in the video, e.g. 'Happy birthday, Sarah!'. Optional, at most two sentences."),
          },
          required: ["prompt"],
        },
        run: (input, emit) => asOutcome(() => startVideo(context(base, emit), input as never)),
      },
      {
        name: "get_video_status",
        description: "Check a video job started earlier: queued, processing, done or failed. Only when the user asks how their video is going.",
        status: "Checking your video…",
        inputSchema: {
          type: "object",
          properties: { job_id: str("The job id returned when the video was started.") },
          required: ["job_id"],
        },
        run: (input) => asOutcome(() => videoStatus(base.userId, String((input as { job_id?: string }).job_id ?? ""))),
      }
    );
  }

  if (opts.slideshow) {
    tools.push({
      name: "make_slideshow_video",
      description:
        "Make an MP4 slideshow video: slides of headings and text, each optionally over a generated picture, fading from one to the next. Best for school presentations, explainers, announcements and simple birthday or thank-you videos. Ready in under a minute. Write the slide text yourself from what the user wants.",
      status: "Making your slideshow…",
      inputSchema: {
        type: "object",
        properties: {
          title: str("Title of the video, used for the filename."),
          slides: {
            type: "array",
            minItems: 1,
            maxItems: 15,
            items: {
              type: "object",
              properties: {
                heading: str("Short heading, under 8 words."),
                text: str("One to three short sentences."),
                ...(opts.generation ? { image_prompt: str("Optional: a picture to fill this slide behind the text. Leave out for a plain colour slide.") } : {}),
              },
            },
          },
          aspect_ratio: { type: "string", enum: ["16:9", "9:16", "1:1"] },
          seconds_per_slide: { type: "integer", minimum: 2, maximum: 10, description: "4 by default." },
          colors: { type: "array", items: { type: "string" }, maxItems: 2, description: "Two hex colours for the background gradient." },
        },
        required: ["slides"],
      },
      run: (input, emit) => asOutcome(() => startSlideshow(context(base, emit), input as never)),
    });
  }

  return tools;
}
