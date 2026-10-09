import { getFieldDef, maskValue, verhoeffValid } from "@ufa/shared";
import type { ChatFact } from "./facts";

/**
 * Masks sensitive identifiers in a chat message before it is stored, so chat
 * history never holds raw Aadhaar/PAN/bank/passport numbers. The extracted
 * values themselves are kept encrypted in the proposal rows.
 */
export function maskSensitiveText(text: string, facts: ChatFact[] = []): { text: string; masked: boolean } {
  let out = text;
  for (const f of facts) {
    const def = getFieldDef(f.fieldKey);
    if (def && def.sensitivity !== "normal" && f.raw && out.includes(f.raw)) {
      out = out.split(f.raw).join(maskValue(f.raw));
    }
  }
  // Safety net for identifiers mentioned without a recognised phrase.
  out = out.replace(/(?<!\d)([2-9]\d{3})([\s-]?)(\d{4})\2(\d{4})(?!\d)/g, (m, a: string, _s: string, b: string, c: string) =>
    verhoeffValid(a + b + c) ? maskValue(a + b + c) : m,
  );
  out = out.replace(/\b[A-Za-z]{3}[ABCFGHLJPTKabcfghljptk][A-Za-z]\d{4}[A-Za-z]\b/g, (m) => maskValue(m));
  // Long digit runs (bank accounts); 10-digit Indian mobile numbers are left readable.
  out = out.replace(/(?<!\d)\d{11,18}(?!\d)/g, (m) => maskValue(m));
  out = out.replace(/(?<!\d)\d{9}(?!\d)/g, (m) => maskValue(m));
  return { text: out, masked: out !== text };
}
