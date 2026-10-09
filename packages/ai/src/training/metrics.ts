/**
 * Model evaluation metrics (spec §53). One implementation for every model —
 * the rules baseline, a local model behind Ollama, or a fine-tuned candidate's
 * predictions file — so comparisons are apples to apples.
 *
 * Expected/predicted use profile keys, with null meaning "none" (abstain / not a profile field).
 */
export interface Prediction {
  id: string;
  expected: string | null;
  predicted: string | null;
  confidence: number;
  language?: string;
}

export interface Metrics {
  n: number;
  /** Correct answers (including correct "none") / all. */
  accuracy: number;
  /** Answered with a key / all. */
  coverage: number;
  /** Said "none" / all. */
  abstentionRate: number;
  /** Answered with a key that is wrong (or answered where "none" was right) / all — the number that matters most. */
  wrongRate: number;
  /** Correct keys / answered keys. */
  precision: number;
  /** Correct keys / fields that have a key. */
  recall: number;
  macroF1: number;
  /** Expected calibration error over answered predictions (10 bins). */
  ece: number;
  perLanguage: Record<string, { n: number; accuracy: number; wrongRate: number }>;
  perCategory: Record<string, { n: number; accuracy: number; wrongRate: number }>;
  topErrors: Array<{ expected: string; predicted: string; count: number }>;
}

const round = (x: number) => Math.round(x * 10000) / 10000;
const category = (key: string | null) => (key ? key.split(".")[0]! : "none");

function basic(ps: Prediction[]) {
  const n = ps.length;
  const correct = ps.filter((p) => p.predicted === p.expected).length;
  const wrong = ps.filter((p) => p.predicted !== null && p.predicted !== p.expected).length;
  return { n, accuracy: n ? round(correct / n) : 0, wrongRate: n ? round(wrong / n) : 0 };
}

export function computeMetrics(preds: Prediction[]): Metrics {
  const n = preds.length;
  const answered = preds.filter((p) => p.predicted !== null);
  const withKey = preds.filter((p) => p.expected !== null);
  const correctAnswered = answered.filter((p) => p.predicted === p.expected).length;

  // Macro F1 over profile keys (excluding "none").
  const keys = new Set([...preds.map((p) => p.expected), ...preds.map((p) => p.predicted)].filter((k): k is string => k !== null));
  const f1s = [...keys].map((k) => {
    const tp = preds.filter((p) => p.predicted === k && p.expected === k).length;
    const fp = preds.filter((p) => p.predicted === k && p.expected !== k).length;
    const fn = preds.filter((p) => p.expected === k && p.predicted !== k).length;
    const prec = tp + fp ? tp / (tp + fp) : 0;
    const rec = tp + fn ? tp / (tp + fn) : 0;
    return prec + rec ? (2 * prec * rec) / (prec + rec) : 0;
  });

  // Calibration: does "80% sure" mean right 80% of the time?
  const bins = Array.from({ length: 10 }, () => ({ n: 0, conf: 0, acc: 0 }));
  for (const p of answered) {
    const b = bins[Math.min(9, Math.floor(Math.max(0, Math.min(1, p.confidence)) * 10))]!;
    b.n++;
    b.conf += p.confidence;
    b.acc += p.predicted === p.expected ? 1 : 0;
  }
  const ece = answered.length ? bins.reduce((s, b) => s + (b.n ? (b.n / answered.length) * Math.abs(b.acc / b.n - b.conf / b.n) : 0), 0) : 0;

  const group = (f: (p: Prediction) => string) => {
    const m = new Map<string, Prediction[]>();
    for (const p of preds) m.set(f(p), [...(m.get(f(p)) ?? []), p]);
    return Object.fromEntries([...m.entries()].sort().map(([k, ps]) => [k, basic(ps)]));
  };

  const errors = new Map<string, number>();
  for (const p of preds) if (p.predicted !== p.expected) errors.set(`${p.expected ?? "none"}→${p.predicted ?? "none"}`, (errors.get(`${p.expected ?? "none"}→${p.predicted ?? "none"}`) ?? 0) + 1);

  return {
    ...basic(preds),
    n,
    coverage: n ? round(answered.length / n) : 0,
    abstentionRate: n ? round((n - answered.length) / n) : 0,
    precision: answered.length ? round(correctAnswered / answered.length) : 0,
    recall: withKey.length ? round(withKey.filter((p) => p.predicted === p.expected).length / withKey.length) : 0,
    macroF1: f1s.length ? round(f1s.reduce((a, b) => a + b, 0) / f1s.length) : 0,
    ece: round(ece),
    perLanguage: group((p) => p.language ?? "unknown"),
    perCategory: group((p) => category(p.expected)),
    topErrors: [...errors.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([k, count]) => {
        const [expected, predicted] = k.split("→") as [string, string];
        return { expected, predicted, count };
      }),
  };
}

export interface PromotionPolicy {
  /** Highest acceptable share of wrong answers (default 2 %). */
  maxWrongRate: number;
  /** Required accuracy improvement over production (absolute, default 0). */
  minAccuracyGain: number;
  /** Smallest test set a decision may rest on. */
  minTestSize: number;
}

export const DEFAULT_PROMOTION_POLICY: PromotionPolicy = { maxWrongRate: 0.02, minAccuracyGain: 0, minTestSize: 50 };

/**
 * May a candidate replace production? Both must have been evaluated on the same
 * test set. Wrong answers weigh more than accuracy: a model that is more often
 * right but also more often confidently wrong is rejected.
 */
export function promotionDecision(candidate: Metrics, production: Metrics | null, policy: PromotionPolicy = DEFAULT_PROMOTION_POLICY): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (candidate.n < policy.minTestSize) reasons.push(`Test set too small (${candidate.n} < ${policy.minTestSize})`);
  if (candidate.wrongRate > policy.maxWrongRate) reasons.push(`Wrong-mapping rate ${(candidate.wrongRate * 100).toFixed(1)}% is above ${(policy.maxWrongRate * 100).toFixed(1)}%`);
  if (production) {
    if (candidate.accuracy < production.accuracy + policy.minAccuracyGain) {
      reasons.push(`Accuracy ${(candidate.accuracy * 100).toFixed(1)}% does not beat production ${(production.accuracy * 100).toFixed(1)}%`);
    }
    if (candidate.wrongRate > production.wrongRate + 0.005) {
      reasons.push(`More wrong mappings than production (${(candidate.wrongRate * 100).toFixed(1)}% vs ${(production.wrongRate * 100).toFixed(1)}%)`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}
