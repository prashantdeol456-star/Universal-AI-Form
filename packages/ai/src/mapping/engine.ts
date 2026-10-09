import type { NormalizedField } from "@ufa/form-engine";
import { formatFieldValue, getFieldDef, PROFILE_FIELDS } from "@ufa/shared";
import { normalizeLabel } from "@ufa/form-engine";
import type { AIProvider, TokenUsage } from "../providers/types";
import { combine, DEFAULT_THRESHOLDS, isVerifiedKnowledge, knowledgeEvidence, type Thresholds } from "./confidence";
import { fuzzyMatches } from "./fuzzy";
import { conceptsOf, levelOf } from "./lexicon";
import { matchOption } from "./options";
import { AMBIGUOUS_MARK, nonProfileReason, ruleHits } from "./rules";
import type { SemanticIndex } from "./semantic";
import type { Decision, DecisionReason, Evidence, FieldMapping, KnowledgeHit, ProfileValue } from "./types";

/**
 * The decision engine (spec §27, §101) — the one place that turns a form
 * field into AUTO_FILL / USER_REVIEW / ASK_USER / GEMINI / MANUAL.
 *
 *   rules (autocomplete, multilingual lexicon, section context)
 *   → knowledge base (website → user → global)
 *   → fuzzy phrasing match
 *   → semantic search (embeddings, if a local model is configured)
 *   → local AI (only for fields still below the review threshold)
 *   → Gemini fallback (only what is still unresolved; cached; budgeted; always user-confirmed)
 *   → independent confidence (noisy-OR over evidence, penalties)
 *   → decision (value present? verified? sensitive? option matches?)
 *
 * Cheap, deterministic stages run first so the model is called as little as possible (spec §68).
 */
export interface AiCallInfo {
  provider: string;
  model: string;
  operation: "map_fields" | "embed";
  latencyMs: number;
  success: boolean;
  error?: string;
  items: number;
  /** True for the cloud fallback stage (spec §67 "fallback"). */
  fallback?: boolean;
  usage?: TokenUsage;
  /** Per-field answers (recorded for Gemini so later confirmation/correction can be tracked, spec §30). */
  suggestions?: Array<{ fieldId: string; profileField: string | null; confidence: number }>;
}

/** Shared cache of fallback answers. Keys are built from labels/types only — no user data. */
export interface AnswerCache {
  get(keys: string[]): Promise<Map<string, { profileField: string | null; confidence: number }>>;
  set(entries: Array<{ key: string; profileField: string | null; confidence: number }>): Promise<void>;
}

/** Cache key for a field's structure (label, section, type, options). */
export function structureKey(f: Pick<NormalizedField, "label" | "section" | "kind" | "options">): string {
  return [normalizeLabel(f.label), normalizeLabel(f.section ?? ""), f.kind, f.options.slice(0, 12).map(normalizeLabel).join(",")].join("|");
}

export type GeminiStatus = "off" | "not_needed" | "used" | "cached" | "limit_reached" | "failed";

export interface MapFormInput {
  fields: NormalizedField[];
  profile: Map<string, ProfileValue>;
  /** Knowledge-base hits per field id (looked up by the caller). */
  knowledge?: Map<string, KnowledgeHit[]>;
  thresholds?: Thresholds;
  localAi?: AIProvider | null;
  semantic?: SemanticIndex | null;
  /** Cloud fallback (Gemini) for fields nothing else could settle. */
  gemini?: AIProvider | null;
  geminiCache?: AnswerCache | null;
  /** Max fields that may be sent to Gemini in this request (0 = daily limit reached). */
  geminiBudget?: number;
  /**
   * @deprecated kept for callers without a Gemini provider: when true, unknown fields are
   * marked GEMINI ("needs AI help") instead of ASK_USER.
   */
  fallbackAvailable?: boolean;
  onAiCall?: (info: AiCallInfo) => void;
}

export interface MapFormResult {
  mappings: FieldMapping[];
  stats: {
    fields: number;
    matched: number;
    autoFill: number;
    review: number;
    askUser: number;
    manual: number;
    missingValues: number;
    averageConfidence: number | null;
  };
  localAiUsed: boolean;
  semanticUsed: boolean;
  gemini: { status: GeminiStatus; fieldsSent: number; fieldsFromCache: number; fieldsSuggested: number };
}

const CANDIDATE_KEYS = PROFILE_FIELDS.map((d) => ({ key: d.key, label: d.label.en }));

/** Upper bound on any model's self-reported confidence, enforced by the engine. */
export const MODEL_CONFIDENCE_CAP = 0.8;
/** Gemini is the designated fallback: it may reach "review" on its own, never auto-fill. */
export const GEMINI_CONFIDENCE_CAP = 0.85;
const geminiWeight = (c: number) => Math.round(Math.min(Math.max(c, 0), GEMINI_CONFIDENCE_CAP) * 0.95 * 1000) / 1000;

function levelFromQualification(value: string | undefined): string | null {
  if (!value) return null;
  return levelOf(conceptsOf(value).concepts);
}

/** Clear type mismatches count against a candidate (a name never goes into a date picker). */
function compatibility(field: NormalizedField, key: string): Evidence | null {
  const def = getFieldDef(key);
  if (!def) return null;
  const k = field.kind;
  if (k === "email" && key !== "contact.email") return { source: "input_type", weight: -0.6, detail: "email input" };
  if (k === "date" && def.input !== "date") return { source: "input_type", weight: -0.6, detail: "date input" };
  if (k === "tel" && !key.includes("mobile")) return { source: "input_type", weight: -0.4, detail: "phone input" };
  if (k === "number" && def.validator === "person_name") return { source: "input_type", weight: -0.6, detail: "number input" };
  if (k === "checkbox" && field.options.length <= 1 && def.input !== "yes_no") return { source: "input_type", weight: -0.6, detail: "single checkbox" };
  return null;
}

function decide(
  field: NormalizedField,
  ranked: Array<{ fieldKey: string; confidence: number; ev: Evidence[] }>,
  profile: Map<string, ProfileValue>,
  t: Thresholds,
  fallbackAvailable: boolean,
): { decision: Decision; reason: DecisionReason; optionMatch: string | null } {
  const top = ranked[0];
  if (!top || top.confidence < t.review) return { decision: fallbackAvailable ? "GEMINI" : "ASK_USER", reason: "unknown_field", optionMatch: null };
  // Ambiguous labels always need review — unless a person already told us what this field is.
  if (top.ev.some((e) => e.detail?.startsWith(AMBIGUOUS_MARK)) && !top.ev.some(isVerifiedKnowledge)) {
    return { decision: "USER_REVIEW", reason: "ambiguous", optionMatch: null };
  }
  const second = ranked[1];
  if (second && second.confidence >= t.review && top.confidence - second.confidence < 0.08) return { decision: "USER_REVIEW", reason: "ambiguous", optionMatch: null };

  const value = profile.get(top.fieldKey);
  if (!value) return { decision: "ASK_USER", reason: "missing_value", optionMatch: null };
  // Spec §27: a Gemini answer is always shown to the user for confirmation —
  // unless rules or verified knowledge independently support the same field.
  const geminiOnly =
    top.ev.some((e) => e.source === "gemini") &&
    !top.ev.some(isVerifiedKnowledge) &&
    combine(top.ev.filter((e) => e.source !== "gemini" && e.source !== "local_ai" && e.source !== "semantic")) < t.review;

  let optionMatch: string | null = null;
  if (field.options.length && ["select", "radio", "combobox", "checkbox"].includes(field.kind)) {
    optionMatch = matchOption(formatFieldValue(top.fieldKey, value.value), field.options);
    if (!optionMatch) return { decision: "USER_REVIEW", reason: "option_mismatch", optionMatch: null };
  }
  if (geminiOnly) return { decision: "USER_REVIEW", reason: "ai_suggestion", optionMatch };
  if (value.sensitive) return { decision: "USER_REVIEW", reason: "sensitive", optionMatch };
  if (!value.verified) return { decision: "USER_REVIEW", reason: "value_unverified", optionMatch };
  if (top.confidence >= t.auto) return { decision: "AUTO_FILL", reason: "confident", optionMatch };
  return { decision: "USER_REVIEW", reason: "needs_review", optionMatch };
}

export async function mapForm(input: MapFormInput): Promise<MapFormResult> {
  const t = input.thresholds ?? DEFAULT_THRESHOLDS;
  const evidence = new Map<string, Map<string, Evidence[]>>(); // fieldId -> key -> evidence
  const fixed = new Map<string, FieldMapping>(); // decided without matching (manual / not a profile field)
  const add = (fieldId: string, key: string, e: Evidence) => {
    const m = evidence.get(fieldId) ?? new Map<string, Evidence[]>();
    m.set(key, [...(m.get(key) ?? []), e]);
    evidence.set(fieldId, m);
  };
  const best = (fieldId: string) => Math.max(0, ...[...(evidence.get(fieldId)?.values() ?? [])].map(combine));

  const manual = (f: NormalizedField, reason: DecisionReason): FieldMapping => ({
    fieldId: f.id, profileFieldKey: null, confidence: 1, decision: "MANUAL", reason, candidates: [], evidence: [], optionMatch: null,
  });

  // 1. Never-automated fields and deterministic evidence.
  for (const f of input.fields) {
    const np = f.manual ?? nonProfileReason(f);
    if (np) {
      fixed.set(f.id, manual(f, np === "unsupported_control" ? "not_profile_field" : np));
      continue;
    }
    const kb = input.knowledge?.get(f.id) ?? [];
    if (kb.some((h) => h.fieldKey === null && h.verified && (h.scope === "WEBSITE" || h.scope === "USER"))) {
      fixed.set(f.id, manual(f, "not_profile_field"));
      continue;
    }
    for (const h of kb) if (h.fieldKey) add(f.id, h.fieldKey, knowledgeEvidence(h));
    for (const r of ruleHits(f)) add(f.id, r.fieldKey, r.evidence);
  }
  const open = () => input.fields.filter((f) => !fixed.has(f.id) && best(f.id) < t.review);

  // 2. Fuzzy phrasing match for what the rules did not settle.
  for (const f of open()) {
    for (const m of fuzzyMatches(f.label)) {
      add(f.id, m.fieldKey, { source: "fuzzy", weight: Math.min(0.8, Math.max(0, (m.similarity - 0.5) * 1.6)), detail: `≈ "${m.phrase}" (${m.similarity.toFixed(2)})` });
    }
  }

  // 3. Semantic search (embeddings).
  let semanticUsed = false;
  if (input.semantic) {
    const pending = open();
    if (pending.length) {
      const started = Date.now();
      try {
        const hits = await input.semantic.nearest(pending.map((f) => (f.section ? `${f.label} (${f.section})` : f.label)));
        hits.forEach((h, i) => {
          if (h && h.score >= 0.78) add(pending[i]!.id, h.fieldKey, { source: "semantic", weight: Math.min(0.6, (h.score - 0.75) * 2.5), detail: `≈ "${h.phrase}" (${h.score.toFixed(2)})` });
        });
        semanticUsed = true;
        input.onAiCall?.({ provider: input.localAi?.name ?? "local", model: input.localAi?.model ?? "", operation: "embed", latencyMs: Date.now() - started, success: true, items: pending.length });
      } catch (err) {
        input.onAiCall?.({ provider: "local", model: input.localAi?.model ?? "", operation: "embed", latencyMs: Date.now() - started, success: false, error: String(err), items: pending.length });
      }
    }
  }

  // 4. Local AI for the remaining hard fields only.
  let localAiUsed = false;
  if (input.localAi) {
    const pending = open();
    if (pending.length) {
      const started = Date.now();
      try {
        const { suggestions } = await input.localAi.mapFields({
          fields: pending.map((f) => ({ id: f.id, label: f.label, section: f.section, kind: f.kind, options: f.options })),
          candidates: CANDIDATE_KEYS,
        });
        for (const s of suggestions) {
          // Capped here regardless of provider: a model alone can suggest, never reach review/auto-fill.
          const weight = Math.round(Math.min(Math.max(s.confidence, 0), MODEL_CONFIDENCE_CAP) * 0.8 * 1000) / 1000;
          if (s.profileField && getFieldDef(s.profileField)) add(s.fieldId, s.profileField, { source: "local_ai", weight, detail: `${input.localAi.model}` });
        }
        localAiUsed = true;
        input.onAiCall?.({ provider: input.localAi.name, model: input.localAi.model, operation: "map_fields", latencyMs: Date.now() - started, success: true, items: pending.length });
      } catch (err) {
        input.onAiCall?.({ provider: input.localAi.name, model: input.localAi.model, operation: "map_fields", latencyMs: Date.now() - started, success: false, error: String(err), items: pending.length });
      }
    }
  }

  // 5. Gemini fallback: only fields still unresolved, cache first, within budget.
  const gemini: MapFormResult["gemini"] = { status: input.gemini ? "not_needed" : "off", fieldsSent: 0, fieldsFromCache: 0, fieldsSuggested: 0 };
  const geminiSkipped = new Set<string>();
  if (input.gemini) {
    const pending = open();
    if (pending.length) {
      const keys = new Map(pending.map((f) => [f.id, structureKey(f)]));
      const cached = input.geminiCache ? await input.geminiCache.get([...new Set(keys.values())]).catch(() => new Map()) : new Map();
      const uncached: NormalizedField[] = [];
      for (const f of pending) {
        const hit = cached.get(keys.get(f.id)!);
        if (hit) {
          gemini.fieldsFromCache++;
          if (hit.profileField && getFieldDef(hit.profileField)) {
            add(f.id, hit.profileField, { source: "gemini", weight: geminiWeight(hit.confidence), detail: "gemini (cached answer)" });
            gemini.fieldsSuggested++;
          }
        } else uncached.push(f);
      }
      if (gemini.fieldsFromCache) gemini.status = "cached";
      const budget = Math.max(0, input.geminiBudget ?? Number.POSITIVE_INFINITY);
      const toSend = uncached.slice(0, budget);
      uncached.slice(toSend.length).forEach((f) => geminiSkipped.add(f.id));
      if (geminiSkipped.size) gemini.status = "limit_reached";
      if (toSend.length) {
        const started = Date.now();
        try {
          const { suggestions, usage } = await input.gemini.mapFields({
            fields: toSend.map((f) => ({ id: f.id, label: f.label, section: f.section, kind: f.kind, options: f.options })),
            candidates: CANDIDATE_KEYS,
          });
          const byId = new Map(suggestions.map((s) => [s.fieldId, s]));
          const toCache: Array<{ key: string; profileField: string | null; confidence: number }> = [];
          for (const f of toSend) {
            const s = byId.get(f.id);
            const key = s?.profileField && getFieldDef(s.profileField) ? s.profileField : null;
            toCache.push({ key: keys.get(f.id)!, profileField: key, confidence: s?.confidence ?? 0 });
            if (key) {
              add(f.id, key, { source: "gemini", weight: geminiWeight(s!.confidence), detail: input.gemini.model });
              gemini.fieldsSuggested++;
            }
          }
          await input.geminiCache?.set(toCache).catch(() => {});
          gemini.fieldsSent = toSend.length;
          if (!geminiSkipped.size) gemini.status = "used";
          input.onAiCall?.({
            provider: input.gemini.name, model: input.gemini.model, operation: "map_fields", latencyMs: Date.now() - started, success: true,
            items: toSend.length, fallback: true, usage, suggestions: toSend.map((f) => ({ fieldId: f.id, profileField: byId.get(f.id)?.profileField ?? null, confidence: byId.get(f.id)?.confidence ?? 0 })),
          });
        } catch (err) {
          gemini.status = "failed";
          input.onAiCall?.({ provider: input.gemini.name, model: input.gemini.model, operation: "map_fields", latencyMs: Date.now() - started, success: false, error: String(err), items: toSend.length, fallback: true });
        }
      }
    }
  }

  // 6. Confidence + decision for every field.
  const mappings: FieldMapping[] = input.fields.map((f) => {
    const done = fixed.get(f.id);
    if (done) return done;
    const perKey = evidence.get(f.id) ?? new Map<string, Evidence[]>();
    const highestLevel = levelFromQualification(input.profile.get("education.highest_qualification")?.value);
    for (const [key, ev] of perKey) {
      // "Year of Passing" with no level in label/section: lean towards the user's highest qualification.
      if (highestLevel && key.startsWith(`education.${highestLevel}.`) && ev.some((e) => e.detail?.includes("level unknown"))) {
        ev.push({ source: "profile", weight: 0.4, detail: "matches your highest qualification" });
      }
      const c = compatibility(f, key);
      if (c) ev.push(c);
      // Profile evidence breaks ties between rule-backed candidates (e.g. which education level).
      // It never lifts a suggestion that only a model made.
      const deterministic = combine(ev.filter((e) => e.source !== "local_ai" && e.source !== "semantic" && e.source !== "gemini"));
      if (perKey.size > 1 && deterministic >= 0.4 && input.profile.has(key)) ev.push({ source: "profile", weight: 0.15, detail: "you have this value" });
    }
    const ranked = [...perKey.entries()]
      .map(([fieldKey, ev]) => ({ fieldKey, confidence: combine(ev), ev }))
      .filter((r) => r.confidence > 0)
      .sort((a, b) => b.confidence - a.confidence);
    // "Needs AI help": Gemini would have been asked but the daily limit was reached.
    const d = decide(f, ranked, input.profile, t, Boolean(input.fallbackAvailable) || geminiSkipped.has(f.id));
    const top = ranked[0];
    const keep = top && top.confidence >= t.review;
    return {
      fieldId: f.id,
      profileFieldKey: keep ? top.fieldKey : null,
      confidence: top?.confidence ?? 0,
      decision: d.decision,
      reason: d.reason,
      candidates: ranked.slice(0, 3).map((r) => ({ fieldKey: r.fieldKey, confidence: r.confidence })),
      evidence: top?.ev ?? [],
      optionMatch: d.optionMatch,
    };
  });

  const counted = mappings.filter((m) => input.fields.find((f) => f.id === m.fieldId)?.visible !== false);
  const matched = counted.filter((m) => m.profileFieldKey);
  return {
    mappings,
    stats: {
      fields: counted.length,
      matched: matched.length,
      autoFill: counted.filter((m) => m.decision === "AUTO_FILL").length,
      review: counted.filter((m) => m.decision === "USER_REVIEW").length,
      askUser: counted.filter((m) => m.decision === "ASK_USER" || m.decision === "GEMINI").length,
      manual: counted.filter((m) => m.decision === "MANUAL").length,
      missingValues: counted.filter((m) => m.reason === "missing_value").length,
      averageConfidence: matched.length ? Math.round((matched.reduce((s, m) => s + m.confidence, 0) / matched.length) * 100) / 100 : null,
    },
    localAiUsed,
    semanticUsed,
    gemini,
  };
}
