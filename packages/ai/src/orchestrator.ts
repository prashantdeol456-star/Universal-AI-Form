import type { NormalizedField } from "@ufa/form-engine";
import { DEFAULT_THRESHOLDS, type Thresholds } from "./mapping/confidence";
import { mapForm, type AiCallInfo, type AnswerCache, type MapFormResult } from "./mapping/engine";
import { SemanticIndex, type LabelVectorStore } from "./mapping/semantic";
import type { KnowledgeHit, ProfileValue } from "./mapping/types";
import type { AIProvider } from "./providers/types";

/**
 * AIOrchestrator (spec §27, §101): owns the configured providers and runs the
 * one decision pipeline. Business code asks it to map a form; it never calls a
 * provider directly, so providers can be added, swapped or disabled in one place.
 *
 *   rules → knowledge base → fuzzy → semantic (local embeddings) → local AI → Gemini → confidence → decision
 *
 * Works with any subset of providers: with none, rules + knowledge base still
 * map most fields (Gemini/local AI are never a single point of failure, spec §90).
 */
export interface OrchestratorConfig {
  localAi?: AIProvider | null;
  gemini?: AIProvider | null;
  geminiCache?: AnswerCache | null;
  /** Use the local provider's embeddings for semantic matching (needs an embedding model). */
  semantic?: boolean;
  /** Optional shared-label vector store (pgvector) searched alongside the reference phrases. */
  labelStore?: LabelVectorStore | null;
  thresholds?: Thresholds;
}

export interface MapRequest {
  fields: NormalizedField[];
  profile: Map<string, ProfileValue>;
  knowledge?: Map<string, KnowledgeHit[]>;
  /** Per-request permission and budget for the cloud fallback. */
  allowCloudAi?: boolean;
  geminiBudget?: number;
  onAiCall?: (info: AiCallInfo) => void;
}

export class AIOrchestrator {
  private readonly semantic: SemanticIndex | null;

  constructor(private readonly cfg: OrchestratorConfig) {
    this.semantic = cfg.semantic && cfg.localAi?.embed ? new SemanticIndex(cfg.localAi, cfg.labelStore ?? null) : null;
  }

  get providers() {
    return { localAi: this.cfg.localAi?.model ?? null, gemini: this.cfg.gemini?.model ?? null, semantic: Boolean(this.semantic) };
  }

  mapForm(req: MapRequest): Promise<MapFormResult> {
    const gemini = req.allowCloudAi === false ? null : (this.cfg.gemini ?? null);
    return mapForm({
      fields: req.fields,
      profile: req.profile,
      knowledge: req.knowledge,
      thresholds: this.cfg.thresholds ?? DEFAULT_THRESHOLDS,
      localAi: this.cfg.localAi ?? null,
      semantic: this.semantic,
      gemini,
      geminiCache: gemini ? (this.cfg.geminiCache ?? null) : null,
      geminiBudget: req.geminiBudget,
      onAiCall: req.onAiCall,
    });
  }
}
