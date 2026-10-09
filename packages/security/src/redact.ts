/**
 * Redacts identifiers that must never reach ordinary logs
 * (Aadhaar, PAN, bank accounts, OTPs, emails, mobile numbers, bearer tokens).
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]"],
  [/\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}\b/g, "[AADHAAR]"],
  [/\b[A-Z]{5}\d{4}[A-Z]\b/g, "[PAN]"],
  [/\b[A-Z]{4}0[A-Z0-9]{6}\b/g, "[IFSC]"],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[EMAIL]"],
  [/(?<!\d)(?:\+91[\s-]?)?[6-9]\d{9}(?!\d)/g, "[MOBILE]"],
  [/\b\d{9,18}\b/g, "[NUMBER]"],
  [/\b(otp|code|password|token)(["':=\s]+)[^\s"',}]+/gi, "$1$2[REDACTED]"],
];

export function redact(input: string): string {
  let out = input;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

const SENSITIVE_KEYS = /pass(word)?|token|secret|otp|aadhaar|pan|account|ifsc|authorization|cookie|value/i;

/** Deep-redacts an object for structured logging. */
export function redactObject(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[DEPTH]";
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactObject(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEYS.test(k) ? "[REDACTED]" : redactObject(v, depth + 1);
    }
    return out;
  }
  return value;
}
