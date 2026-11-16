import "dotenv/config";
import { z } from "zod";

// Fail loudly at boot rather than at the first request. A backend that starts
// without a database URL or JWT secret is not "running" in any useful sense.
const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required (a postgres:// connection string)"),

  // Signs the bearer tokens used by both the web and mobile clients.
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_EXPIRES_IN: z.string().default("30d"),

  // Optional — the provider layer reports "not configured" rather than faking
  // responses when this is absent.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5-5"),

  // Optional second provider. Absent means its models simply are not offered.
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_BASE_URL: z.string().default("https://api.deepseek.com"),

  // Image and video generation (fal.ai). Absent means the tools are not
  // offered, and the assistant says plainly that it cannot make pictures or
  // video here. FAL_BASE_URL is only changed for tests, to point at a stub.
  FAL_KEY: z.string().optional(),
  FAL_QUEUE_URL: z.string().default("https://queue.fal.run"),
  // Where this API is reachable from the internet, for the media service's
  // "your video is ready" webhook. Without it, finished videos are found by
  // polling, which works the same, just up to a few seconds later.
  PUBLIC_API_URL: z.string().optional(),

  // The voice server (astraeya-voice), which makes speech from text. On Render
  // this is the private service's internal address. Without it, the app falls
  // back to the browser's own voices and says so.
  VOICE_SERVICE_URL: z.string().default("http://127.0.0.1:5005"),
  // Shared secret the voice server checks, so only this API can use it.
  VOICE_SECRET: z.string().optional(),
  // Optional separate speech-to-text server (the voice server started with
  // VOICE_STT_ONLY=1). Unset: the main voice server does speech-to-text too.
  VOICE_STT_URL: z.string().optional(),
  // Hosted speech (DeepInfra: the same Kokoro voices and Whisper, on GPUs).
  // Set it and speaking and listening become near-instant; unset, Astraeya's
  // own voice server does both. Reply text and recordings then go to DeepInfra.
  DEEPINFRA_API_KEY: z.string().optional(),
  DEEPINFRA_BASE_URL: z.string().optional(),

  // Comma-separated list of browser origins allowed to call this API.
  // Native mobile clients send no Origin header and are always allowed.
  CORS_ORIGINS: z.string().default("http://localhost:3000"),

  WEB_SEARCH_PROVIDER: z.string().optional(),

  // The offline fallback model. LOCAL_MODEL_DIR may be absolute — on Render it
  // points at the persistent disk so the file survives a redeploy.
  LOCAL_MODEL_DIR: z.string().default("models"),
  LOCAL_MODEL_FILE: z.string().default("Llama-3.2-3B-Instruct-Q4_K_M.gguf"),

  // Local AI runtime. An Ollama daemon here means models can be listed,
  // installed and removed from Settings; without one, the bundled GGUF above is
  // used and is managed as a file on the host. Never needs an API key, and
  // nothing sent to it leaves the machine it runs on.
  OLLAMA_BASE_URL: z.string().default("http://127.0.0.1:11434"),

  // Comma-separated emails granted admin access regardless of stored role.
  // Requires those people to have an Astraeya account.
  ADMIN_EMAILS: z.string().default(""),

  // A standalone owner login for the dashboard, needing no Astraeya account at
  // all. Set both to enable it. Kept in the environment rather than the code
  // because this repository is public.
  ADMIN_EMAIL: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

export const env = parsed.data;

export const corsOrigins = env.CORS_ORIGINS.split(",")
  .map((o) => o.trim())
  .filter(Boolean);

export const isProduction = env.NODE_ENV === "production";
