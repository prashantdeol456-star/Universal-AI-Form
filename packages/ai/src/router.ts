import type { GeminiProvider } from "./providers/gemini";
import type { LocalAIProvider } from "./providers/local";

/**
 * One place that decides which model may serve a purpose (Phase 0 of the AI browser
 * roadmap). It does not call models itself; services ask it for a provider and keep
 * their own prompts, validation, telemetry and fallbacks.
 *
 * Cloud use needs, in this order: the purpose is implemented, the routing mode allows
 * cloud, a cloud provider is configured, the caller passes the user's consent for this
 * purpose, and the purpose's daily budget is not used up. Consent is never inferred here.
 */

export const AI_PURPOSES = [
  "map_fields",
  "extract_facts",
  "draft_email",
  "draft_answer",
  "match_job",
  "plan_task",
  "understand_document",
  "understand_email",
  "understand_whatsapp",
  "draft_whatsapp_reply",
] as const;
export type AIPurpose = (typeof AI_PURPOSES)[number];

/** Purposes with a real implementation behind the router. The others are reserved and refuse to run. */
export const IMPLEMENTED_PURPOSES: ReadonlySet<AIPurpose> = new Set<AIPurpose>(["map_fields", "draft_email", "draft_answer", "extract_facts", "match_job", "understand_email", "understand_whatsapp", "draft_whatsapp_reply"]);

/**
 * - local_only: never call a cloud model;
 * - hybrid: local and rule-based paths first, cloud as fallback (today's behaviour);
 * - cloud_enabled: reserved for purposes that prefer cloud quality; behaves like hybrid until such a purpose exists.
 */
export const ROUTING_MODES = ["local_only", "hybrid", "cloud_enabled"] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

export interface CloudRequest {
  /** The user's consent for sending this purpose's data to the cloud (checked by the caller from their settings). */
  consent: boolean;
  /** Successful cloud calls for this purpose today, and the limit. Omit for purposes budgeted elsewhere. */
  usedToday?: number;
  dailyLimit?: number;
}

export type CloudDecision =
  | { allowed: true; provider: GeminiProvider }
  | { allowed: false; reason: "not_implemented" | "local_only" | "not_configured" | "no_consent" | "over_budget" };

export class PurposeNotImplementedError extends Error {
  constructor(public purpose: string) {
    super(`AI purpose "${purpose}" is not implemented yet`);
    this.name = "PurposeNotImplementedError";
  }
}

export interface ModelRouterOptions {
  mode: RoutingMode;
  local: LocalAIProvider | null;
  gemini: GeminiProvider | null;
}

export class ModelRouter {
  readonly mode: RoutingMode;
  private readonly localProvider: LocalAIProvider | null;
  private readonly geminiProvider: GeminiProvider | null;

  constructor(opts: ModelRouterOptions) {
    this.mode = opts.mode;
    this.localProvider = opts.local;
    this.geminiProvider = opts.gemini;
  }

  private assertImplemented(purpose: AIPurpose) {
    if (!IMPLEMENTED_PURPOSES.has(purpose)) throw new PurposeNotImplementedError(purpose);
  }

  /** The local model for a purpose (null when none is configured). */
  local(purpose: AIPurpose): LocalAIProvider | null {
    this.assertImplemented(purpose);
    return this.localProvider;
  }

  /** Whether cloud AI could serve this purpose at all (mode + configuration), before consent and budget. */
  cloudAvailable(purpose: AIPurpose): boolean {
    this.assertImplemented(purpose);
    return this.mode !== "local_only" && this.geminiProvider !== null;
  }

  /**
   * The cloud provider for a purpose when routing, consent and budget allow it. Purposes whose
   * budget and consent are applied per field by the orchestrator (map_fields) pass consent: true
   * here and keep their own checks.
   */
  cloud(purpose: AIPurpose, req: CloudRequest): CloudDecision {
    if (!IMPLEMENTED_PURPOSES.has(purpose)) return { allowed: false, reason: "not_implemented" };
    if (this.mode === "local_only") return { allowed: false, reason: "local_only" };
    if (!this.geminiProvider) return { allowed: false, reason: "not_configured" };
    if (!req.consent) return { allowed: false, reason: "no_consent" };
    if (req.dailyLimit !== undefined && (req.usedToday ?? 0) >= req.dailyLimit) return { allowed: false, reason: "over_budget" };
    return { allowed: true, provider: this.geminiProvider };
  }
}
