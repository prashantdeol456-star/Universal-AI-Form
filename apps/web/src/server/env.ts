import "server-only";
import { z } from "zod";

/**
 * Server environment, validated once at first use. Never import this from
 * client components — secrets live here.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.url().default("http://localhost:3000"),

  DATABASE_URL: z.string().min(1),
  DATABASE_APP_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(2).max(100).default(10),

  // HMAC secret for OTP hashing and signed file URLs.
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  DATA_ENCRYPTION_KEYS: z.string().min(1),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: z.stringbool().default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().default("Universal AI Form Assistant <no-reply@localhost>"),

  STORAGE_DRIVER: z.enum(["local"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default("./storage"),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(50).default(10),
  // Background document processing (OCR + extraction) inside the web process.
  DOCUMENT_WORKER_ENABLED: z.stringbool().default(true),
  OCR_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(120_000),
  // Optional ClamAV daemon (docker compose --profile antivirus). Empty = scanning skipped.
  CLAMAV_HOST: z.string().optional(),
  CLAMAV_PORT: z.coerce.number().int().default(3310),

  LOCAL_AI_ENABLED: z.stringbool().default(false),
  LOCAL_AI_BASE_URL: z.string().default("http://localhost:11434"),
  LOCAL_AI_MODEL: z.string().default("qwen2.5:7b-instruct"),
  LOCAL_AI_API_KEY: z.string().optional(),
  // Embedding model for semantic field matching (empty = off). e.g. nomic-embed-text
  LOCAL_AI_EMBED_MODEL: z.string().default(""),
  GEMINI_ENABLED: z.stringbool().default(false),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-3.5-flash"),
  // Optional override (corporate proxy / local testing). Default: Google's public endpoint.
  GEMINI_BASE_URL: z.string().default("https://generativelanguage.googleapis.com/v1beta"),
  // Cost control: max fields sent to Gemini per user per day, and per form analysis.
  GEMINI_DAILY_FIELD_LIMIT: z.coerce.number().int().min(0).max(100_000).default(200),
  GEMINI_MAX_FIELDS_PER_REQUEST: z.coerce.number().int().min(1).max(200).default(40),
  // How long a cached fallback answer is reused.
  AI_CACHE_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  AI_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.9),
  AI_FALLBACK_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
  // Email drafts written by Gemini per user per day (extension "Write email"); templates are used beyond it.
  // Which models may run: local_only never calls a cloud model; hybrid (default) = local/rules first, cloud as fallback.
  AI_ROUTING_MODE: z.enum(["local_only", "hybrid", "cloud_enabled"]).default("hybrid"),
  COMPOSE_DAILY_LIMIT: z.coerce.number().int().min(0).max(10_000).default(30),

  // Learning engine: promotes mappings that several different users agree on (phase 9).
  LEARNING_ENABLED: z.stringbool().default(true),
  LEARNING_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  LEARNING_WEBSITE_MIN_USERS: z.coerce.number().int().min(2).max(1000).default(2),
  LEARNING_GLOBAL_MIN_USERS: z.coerce.number().int().min(3).max(10000).default(3),

  // Hardening (phase 13)
  ADMIN_REQUIRE_MFA: z.stringbool().default(true),
  ACCOUNT_DELETION_GRACE_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  // Bearer token for GET /api/metrics (Prometheus). Empty = endpoint disabled.
  METRICS_TOKEN: z.string().default(""),

  TRUST_PROXY: z.stringbool().default(true),
});

export type ServerEnv = z.infer<typeof schema>;

let cached: ServerEnv | undefined;

export function env(): ServerEnv {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid server environment:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export const isProduction = () => env().NODE_ENV === "production";
