import type { FormSnapshot, NormalizedField } from "@ufa/form-engine";
import type { FieldMappingView, MapResult } from "./api";
import { isFillable, type Selection } from "./Fill";

/**
 * Planning for "Fill everything": which fields the profile or saved answers can
 * fill, which open questions need a written answer, and which facts must be asked
 * in chat. Pure functions (no chrome.* / network) so they can be tested.
 */

const hasValue = (m?: FieldMappingView) => Boolean(m?.profileFieldKey && m.value !== null && m.decision !== "MANUAL");

const OPEN_QUESTION = /tell us about|about yourself|why (do|would|are|should)|describe|explain|cover letter|motivation|what makes you|additional information|anything else|why .*(fit|suitable|join|interested)|introduce yourself|apne baare/i;

/** A free-text question that needs a written answer rather than a fact. */
export const isOpenQuestion = (f: NormalizedField) => f.kind === "textarea" || (f.kind === "text" && OPEN_QUESTION.test(f.label) && f.label.length > 25);

/** "I agree…", "I declare…" boxes: the user ticks these themselves. */
const isDeclaration = (f: NormalizedField) => f.kind === "checkbox" && (/\b(i agree|i accept|i declare|i confirm|i certify|i hereby|i verify|terms|privacy policy|consent)\b/i.test(f.label) || f.options.length <= 1);

export interface AgentPlan {
  /** Pre-filled selection (profile values + saved answers). */
  selection: Selection;
  /** Fields that need a written answer. */
  write: NormalizedField[];
  /** Fields whose answer must be asked in chat. */
  ask: Array<{ field: NormalizedField; mapping?: FieldMappingView }>;
  /** What the user must do themselves (CAPTCHA, OTP, password, consent boxes). */
  yours: NormalizedField[];
}

export function planFill(snapshot: FormSnapshot, mapping: MapResult | null): AgentPlan {
  const byId = new Map((mapping?.fields ?? []).map((m) => [m.fieldId, m]));
  const plan: AgentPlan = { selection: {}, write: [], ask: [], yours: [] };
  for (const f of snapshot.fields) {
    if (!f.visible) continue;
    const m = byId.get(f.id);
    if (f.manual || f.kind === "password" || isDeclaration(f)) {
      if (f.required || f.manual) plan.yours.push(f);
      continue;
    }
    if (!isFillable(f) || f.hasValue) continue;
    if (hasValue(m)) {
      plan.selection[f.id] = { include: true, manualValue: "", overwrite: false };
      continue;
    }
    if (m?.savedAnswer) {
      plan.selection[f.id] = { include: true, manualValue: m.savedAnswer, overwrite: false };
      continue;
    }
    if (isOpenQuestion(f)) plan.write.push(f);
    else if (f.required) plan.ask.push({ field: f, mapping: m });
  }
  return plan;
}

/** The user's chat reply matched against a dropdown / radio's choices ("yes" → "Yes", "linkedin" → "LinkedIn"). */
export function matchOption(options: string[], reply: string): string | null {
  const r = reply.trim().toLowerCase();
  if (!options.length) return reply.trim() || null;
  const exact = options.find((o) => o.trim().toLowerCase() === r);
  if (exact) return exact;
  const yes = /^(yes|haan|ha|han|y|sure|ji|ok)$/i.test(r);
  const no = /^(no|nahi|nahin|na|n)$/i.test(r);
  if (yes || no) return options.find((o) => (yes ? /^yes\b/i : /^no\b/i).test(o.trim())) ?? null;
  const starts = options.filter((o) => o.toLowerCase().startsWith(r) || o.toLowerCase().includes(r));
  return starts.length === 1 ? starts[0]! : null;
}

/** Role the page is about: "Apply: Product Owner", "Application for Accountant – Sharma Traders", "Careers | Data Analyst". */
export function roleOf(snapshot: FormSnapshot): string | null {
  for (const title of [snapshot.formTitle, snapshot.pageTitle]) {
    if (!title) continue;
    const t = title.replace(/\([^)]*\)/g, "").trim();
    const m = /(?:apply(?:ing)?(?:\s+(?:now|for))?|application\s+for|role|position|job|vacancy)\s*[:\-–|]?\s*(.+)/i.exec(t);
    const role = (m?.[1] ?? "").split(/\s[–|-]\s|\s@\s|\sat\s/)[0]!.replace(/^(the|a|an)\s+/i, "").trim();
    if (role.length >= 2 && role.length <= 60) return role;
  }
  return null;
}

export const isFillCommand = (text: string) =>
  /^(fill|start|go|bharo|bhar do|bhardo|form bharo|fill (it|this|the form|everything|all)|sab bharo|auto ?fill|kar do|karo)\b/i.test(text.trim());

export const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"']+/i;
