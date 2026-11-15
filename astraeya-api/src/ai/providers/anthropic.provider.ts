import Anthropic, { toFile } from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { env } from "../../env";
import type {
  AIProvider,
  ChatMessage,
  GenerationOptions,
  StreamChunk,
  WebSource,
} from "../provider.interface";

type SupportedImageMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

const SUPPORTED_IMAGE_TYPES: SupportedImageMediaType[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

function isSupportedImageType(
  mediaType: string
): mediaType is SupportedImageMediaType {
  return (SUPPORTED_IMAGE_TYPES as string[]).includes(mediaType);
}

/** Anthropic's document skills, available in the sandbox when making files. */
const FILE_SKILLS = ["docx", "pptx", "xlsx", "pdf"];

/**
 * Every file id the sandbox produced in a response. Searched structurally
 * rather than by one block shape, so a file from any code-execution result
 * type is picked up.
 */
function collectFileIds(content: unknown): string[] {
  const ids: string[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    // Uploads the user sent in are not outputs.
    if (obj.type === "container_upload") return;
    if (typeof obj.file_id === "string" && String(obj.type ?? "").endsWith("_output")) {
      ids.push(obj.file_id);
    }
    for (const value of Object.values(obj)) visit(value);
  };
  visit(content);
  return ids;
}

/** Models that accept the server-side refusal fallback. */
const FALLBACK_MODELS = new Set(["claude-sonnet-5-5", "claude-opus-5-5"]);

export class AnthropicProvider implements AIProvider {
  readonly id = "anthropic";
  // Internal only — used in logs, never sent to the client. Model tiers are
  // presented by capability instead, so the UI names no vendor and equally
  // never implies Astraeya built the model.
  readonly displayName = "Anthropic";

  //  is about this integration, not the vendor: extended
  // thinking is not wired up here, so Deep think falls back to a prompt
  // instruction rather than a reasoning tier.
  readonly capabilities = {
    webSearch: true,
    images: true,
    reasoning: false,
    temperature: false,
  };

  // Current generation. The tier ids are what accounts store, so upgrading a
  // model here moves every account on that tier without a data migration.
  readonly models = [
    {
      id: "standard",
      modelId: "claude-sonnet-5-5",
      label: "Standard",
      description:
        "Fast and capable, with web search, document reading and image understanding. The default.",
    },
    {
      id: "advanced",
      modelId: "claude-opus-5-5",
      label: "Advanced",
      description:
        "The strongest for hard reasoning, long research and detailed writing. Costs about twice as much per message.",
    },
    {
      id: "quick",
      modelId: "claude-haiku-5-5",
      label: "Quick",
      description:
        "The fastest and cheapest, for short questions and quick checks.",
    },
  ];

  private client: Anthropic | null = null;

  private getClient(): Anthropic {
    if (!this.client) {
      if (!env.ANTHROPIC_API_KEY) {
        throw new Error(
          "ANTHROPIC_API_KEY is not set. Add it to the backend environment."
        );
      }
      this.client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    }
    return this.client;
  }

  isConfigured(): boolean {
    return Boolean(env.ANTHROPIC_API_KEY);
  }

  async *streamCompletion(
    messages: ChatMessage[],
    options?: GenerationOptions
  ): AsyncGenerator<StreamChunk> {
    try {
      const client = this.getClient();

      // Anthropic's Messages API keeps the system prompt separate from the
      // conversation turns and rejects role: "system" inside messages.
      const systemMessages = messages.filter((m) => m.role === "system");
      const turnMessages: Anthropic.MessageParam[] = messages
        .filter((m) => m.role !== "system")
        .map((m) => {
          const images = (m.images ?? []).filter((img) =>
            isSupportedImageType(img.mediaType)
          );

          if (images.length > 0) {
            return {
              role: m.role as "user" | "assistant",
              content: [
                ...images.map((img) => ({
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: img.mediaType as SupportedImageMediaType,
                    data: img.data,
                  },
                })),
                { type: "text" as const, text: m.content || "(no text)" },
              ],
            };
          }

          return {
            role: m.role as "user" | "assistant",
            content: m.content,
          };
        });

      // Prompt caching. The stable account prompt goes in `system`; the notes
      // written for this message go in a system message after the user's
      // latest turn. That keeps everything before it — the system prompt and
      // the whole conversation, documents included — byte-identical between
      // messages, so it is read from cache: faster to the first word, and
      // cheaper.
      const split = options?.stableSystemPrompt !== undefined;
      const systemPrompt =
        (split ? options?.stableSystemPrompt : options?.systemPrompt) ||
        systemMessages.map((m) => m.content).join("\n\n") ||
        undefined;
      const turnNotes = split ? options?.turnNotes?.trim() : "";

      const requestMessages: Anthropic.Beta.BetaMessageParam[] = [
        ...(turnMessages as Anthropic.Beta.BetaMessageParam[]),
      ];

      // ---- File making: the code sandbox and document skills -------------
      const making = options?.fileMaking;
      if (making) {
        yield { type: "status", status: making.uploads.length ? "Reading your files…" : "Getting ready…" };
        // The user's attachments go into the sandbox, so code can open them:
        // the photo to edit, the notes to turn into slides, the data to chart.
        const uploaded = await Promise.all(
          making.uploads.map(async (f) => {
            const meta = await client.files.upload({
              file: await toFile(Buffer.from(f.base64, "base64"), f.name, { type: f.mediaType }),
            });
            return { type: "container_upload" as const, file_id: meta.id };
          })
        );
        const last = requestMessages[requestMessages.length - 1];
        if (uploaded.length > 0 && last?.role === "user") {
          const existing =
            typeof last.content === "string"
              ? [{ type: "text" as const, text: last.content }]
              : last.content;
          last.content = [...existing, ...uploaded];
        }
      }

      if (turnNotes) requestMessages.push({ role: "system", content: turnNotes });

      // Anthropic runs web search server-side: the model issues the queries,
      // reads the results, and cites them, all inside one request. No search
      // API key of our own and no client-side tool loop.
      //
      // The basic search tool is used on purpose. The newer dynamic-filtering
      // variant runs code execution behind the scenes to filter results,
      // which adds noticeable seconds to every searched answer. Three searches
      // cover nearly every question; more mostly adds waiting.
      //
      // Web fetch reads a page whose link is in the conversation — a student
      // pastes a URL and asks about it. Basic variant, for the same reason.
      const tools: Anthropic.Beta.BetaToolUnion[] = [
        ...(options?.webSearch
          ? [
              { type: "web_search_20250305" as const, name: "web_search" as const, max_uses: 3 },
              {
                type: "web_fetch_20250910" as const,
                name: "web_fetch" as const,
                max_uses: 3,
                max_content_tokens: 30000,
              },
            ]
          : []),
        ...(making
          ? [{ type: "code_execution_20260521" as const, name: "code_execution" as const }]
          : []),
      ];

      const model = options?.model ?? env.ANTHROPIC_MODEL;

      // When a safety check declines a request on these models, the API can
      // re-run it on a suitable fallback model inside the same call, so a
      // student is not left with an empty reply. Haiku has no fallback.
      const supportsFallback = FALLBACK_MODELS.has(model);
      const betas = [
        ...(supportsFallback ? ["server-side-fallback-2026-07-01"] : []),
        ...(making ? ["code-execution-2025-08-25"] : []),
      ];

      const container = making
        ? {
            ...(making.containerId ? { id: making.containerId } : {}),
            skills: FILE_SKILLS.map((skill_id) => ({
              type: "anthropic" as const,
              skill_id,
              version: "latest",
            })),
          }
        : undefined;

      let announcedSearch = false;
      let announcedWork = false;
      let wroteText = false;
      let final: Anthropic.Beta.BetaMessage | null = null;
      const madeFileIds = new Set<string>();

      // A long job (building a 15-slide deck) can pause partway; the API then
      // resumes it when the paused turn is sent back. A few rounds at most.
      for (let round = 0; round < 6; round++) {
        // `temperature` is deliberately not sent: it is rejected with a 400 on
        // the current model families. Thinking is left adaptive (the default);
        // `effort` sets how much of it a reply gets.
        // Built as one explicitly typed object: spreading many optional
        // pieces straight into the call makes the type checker expand the
        // SDK's unions until it runs out of memory.
        const params: BetaMessageStreamParams = {
          model,
          max_tokens: making
            ? Math.max(options?.maxTokens ?? 0, 32000)
            : (options?.maxTokens ?? 8192),
          // Caches up to the last cacheable block, moving forward each turn.
          cache_control: { type: "ephemeral" },
          messages: requestMessages,
        };
        if (systemPrompt) params.system = systemPrompt;
        if (tools.length) params.tools = tools;
        if (container) params.container = container;
        if (options?.effort) {
          params.output_config = { effort: making ? "medium" : options.effort };
        }
        if (betas.length) params.betas = betas;
        if (supportsFallback) params.fallbacks = "default";

        const stream = client.beta.messages.stream(params);

        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            wroteText = true;
            yield { type: "text", text: event.delta.text };
          } else if (
            event.type === "content_block_start" &&
            event.content_block.type === "server_tool_use"
          ) {
            const name = event.content_block.name;
            if ((name === "web_search" || name === "web_fetch") && !announcedSearch) {
              // Searching adds seconds of silence before any text arrives.
              // Saying so is the difference between "thinking" and "broken".
              announcedSearch = true;
              yield { type: "searching" };
            } else if (name !== "web_search" && name !== "web_fetch" && !announcedWork) {
              announcedWork = true;
              yield { type: "status", status: "Creating your file…" };
            }
          }
        }

        final = await stream.finalMessage();

        if (env.NODE_ENV === "development") {
          const u = final.usage;
          console.info(
            `[anthropic] ${model} in=${u.input_tokens} cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0} out=${u.output_tokens} stop=${final.stop_reason}`
          );
        }

        // Hand over each finished file as soon as its round completes.
        for (const fileId of collectFileIds(final.content)) {
          if (madeFileIds.has(fileId)) continue;
          madeFileIds.add(fileId);
          try {
            const meta = await client.files.retrieveMetadata(fileId);
            yield {
              type: "file",
              file: {
                providerFileId: fileId,
                filename: meta.filename,
                mediaType: meta.mime_type || "application/octet-stream",
                sizeBytes: meta.size_bytes ?? null,
              },
            };
          } catch (err) {
            console.error("Could not read a generated file:", err instanceof Error ? err.message : err);
          }
        }

        // No client tools are declared, but the model occasionally calls one
        // that sounds right ("view", to look at a file) mid-way through
        // making something. Left alone, the turn ends there with nothing
        // made. Answering the call with an error that points back to the
        // sandbox lets it carry on. Bounded by the round limit.
        // Read through a plain shape: narrowing the SDK's block union here
        // sends the type checker out of memory.
        const blocks = final.content as unknown as { type: string; id?: string; name?: string }[];
        const strayCalls = blocks.filter((b) => b.type === "tool_use" && b.id) as {
          id: string;
          name?: string;
        }[];
        if (final.stop_reason === "tool_use" && strayCalls.length > 0) {
          const results = strayCalls.map((call) => ({
            type: "tool_result" as const,
            tool_use_id: call.id,
            is_error: true,
            content: making
              ? `There is no "${call.name}" tool. Use code_execution (bash and the file editor inside it) to look at files, run code and save the finished files.`
              : `There is no "${call.name}" tool. Answer without it.`,
          }));
          requestMessages.push(
            { role: "assistant", content: final.content as unknown as Anthropic.Beta.BetaContentBlockParam[] },
            { role: "user", content: results as unknown as Anthropic.Beta.BetaContentBlockParam[] }
          );
          continue;
        }

        if (final.stop_reason !== "pause_turn") break;
        // Resume: send the paused turn back as it is, with no extra message.
        requestMessages.push({ role: "assistant", content: final.content as Anthropic.Beta.BetaContentBlockParam[] });
      }

      if (!final) throw new Error("No response from the model");

      if (making && final.container?.id) {
        yield { type: "container", containerId: final.container.id };
      }

      if (options?.webSearch) {
        const sources = extractSources(final as unknown as Anthropic.Message);
        if (sources.length > 0) yield { type: "sources", sources };
      }

      // A declined request returns successfully with no text. Say so, rather
      // than leaving an empty bubble that looks like a crash.
      if (final.stop_reason === "refusal" && !wroteText) {
        yield {
          type: "text",
          text: "I can't help with that request. If this is for your studies, try rephrasing it or explaining what you're working on, and I'll do what I can.",
        };
      } else if (final.stop_reason === "max_tokens") {
        yield {
          type: "text",
          text: "\n\n_(This reply reached its length limit. Say \"continue\" and I'll pick up where I stopped.)_",
        };
      }

      yield { type: "done" };
    } catch (err) {
      // The user gets a sentence they can act on; the operator gets the whole
      // thing, including the request id needed to chase it with the provider.
      console.error(
        "Anthropic provider error:",
        err instanceof Error ? err.message : err
      );
      yield {
        type: "error",
        error: describeProviderError(err),
      };
    }
  }
}

/**
 * Turns a provider failure into something worth showing a user.
 *
 * The raw SDK message is often a JSON blob quoting internal request ids, which
 * is noise to the person typing and a hint about our stack to anyone else. The
 * full error is logged server-side by the caller; this is the sentence that
 * reaches the screen.
 */
/**
 * Pulls the pages the model actually read out of a finished message.
 *
 * A web_search_tool_result's `content` is a list on success and a single error
 * object on failure — the tool reports failures as HTTP 200 rather than
 * throwing, so branching on the shape is the only way to tell them apart.
 */
function extractSources(message: Anthropic.Message): WebSource[] {
  const sources: WebSource[] = [];
  const seen = new Set<string>();

  for (const block of message.content) {
    if (block.type !== "web_search_tool_result") continue;
    if (!Array.isArray(block.content)) continue; // an error object, not results

    for (const result of block.content) {
      if (result.type !== "web_search_result") continue;
      if (seen.has(result.url)) continue; // the model often re-reads a page
      seen.add(result.url);
      sources.push({ title: result.title || result.url, url: result.url });
    }
  }

  return sources;
}

function describeProviderError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "The AI service rejected our credentials. This is a server configuration problem, not something you did.";
  }

  if (err instanceof Anthropic.RateLimitError) {
    return "The AI service is busy right now. Wait a moment and try again.";
  }

  if (err instanceof Anthropic.BadRequestError) {
    const message = err.message.toLowerCase();

    // Anthropic reports a spend cap or exhausted credit as a 400, which would
    // otherwise read as "you sent something malformed" — the opposite of what
    // actually needs doing, and by whom.
    if (message.includes("usage limit") || message.includes("usage limits")) {
      return "This Astraeya account has reached its AI usage limit. The account owner needs to raise the spending limit in the Anthropic console before chat will work again.";
    }
    if (message.includes("credit balance") || message.includes("insufficient")) {
      return "The AI service account is out of credit. The account owner needs to top it up before chat will work again.";
    }
    if (message.includes("too long") || message.includes("max_tokens")) {
      return "This conversation has grown too long for the model to process. Start a new chat to continue.";
    }

    return "The AI service rejected the request. If this keeps happening, the conversation may be too long — try starting a new chat.";
  }

  if (err instanceof Anthropic.APIError) {
    if (err.status && err.status >= 500) {
      return "The AI service is having trouble on its end. Try again shortly.";
    }
    return `The AI service returned an error (${err.status}). Try again shortly.`;
  }

  return "Something went wrong reaching the AI service. Try again.";
}
