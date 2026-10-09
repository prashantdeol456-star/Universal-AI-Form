/**
 * Field value validators. Each validator normalizes the raw input and reports
 * whether it is acceptable. Validators are referenced by name from the profile
 * catalog (and later from per-website rules), so rules stay configurable data.
 */
export type ValidationResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

export type Validator = (raw: string, options?: ValidatorOptions) => ValidationResult;

export interface ValidatorOptions {
  min?: number;
  max?: number;
  options?: readonly string[];
}

const ok = (value: string): ValidationResult => ({ ok: true, value });
const fail = (error: string): ValidationResult => ({ ok: false, error });

// Verhoeff checksum tables (used by Aadhaar).
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function verhoeffValid(digits: string): boolean {
  let c = 0;
  const reversed = digits.split("").reverse();
  for (let i = 0; i < reversed.length; i++) {
    const p = VERHOEFF_P[i % 8]![Number(reversed[i])]!;
    c = VERHOEFF_D[c]![p]!;
  }
  return c === 0;
}

function trimmed(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** ISO calendar date YYYY-MM-DD; also accepts DD/MM/YYYY and DD-MM-YYYY. */
function validateDate(raw: string): ValidationResult {
  const v = trimmed(raw);
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (match) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v))) {
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    return fail("Use date format YYYY-MM-DD or DD/MM/YYYY");
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return fail("Invalid calendar date");
  }
  if (y < 1900 || y > 2100) return fail("Year out of range");
  return ok(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
}

export const validators = {
  text(raw, opts) {
    const v = trimmed(raw);
    if (!v) return fail("Value is required");
    if (v.length > (opts?.max ?? 500)) return fail(`Must be at most ${opts?.max ?? 500} characters`);
    return ok(v);
  },

  person_name(raw) {
    const v = trimmed(raw);
    if (!v) return fail("Name is required");
    if (v.length > 150) return fail("Name is too long");
    // Latin, Devanagari, spaces, dots, apostrophes and hyphens.
    if (!/^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u.test(v)) return fail("Name contains invalid characters");
    return ok(v);
  },

  email(raw) {
    const v = trimmed(raw).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) || v.length > 254) return fail("Invalid email address");
    return ok(v);
  },

  /** Indian mobile number; accepts +91 / 0 prefixes and stores the 10-digit form. */
  mobile_in(raw) {
    let v = raw.replace(/[\s()-]/g, "");
    if (v.startsWith("+91")) v = v.slice(3);
    else if (v.startsWith("0091")) v = v.slice(4);
    else if (v.length === 11 && v.startsWith("0")) v = v.slice(1);
    if (!/^[6-9]\d{9}$/.test(v)) return fail("Enter a valid 10-digit Indian mobile number");
    return ok(v);
  },

  pincode_in(raw) {
    const v = raw.replace(/\s/g, "");
    if (!/^[1-9]\d{5}$/.test(v)) return fail("PIN code must be 6 digits");
    return ok(v);
  },

  date: validateDate,

  past_date(raw) {
    const r = validateDate(raw);
    if (!r.ok) return r;
    if (r.value > new Date().toISOString().slice(0, 10)) return fail("Date cannot be in the future");
    return r;
  },

  year(raw) {
    const v = raw.trim();
    if (!/^\d{4}$/.test(v)) return fail("Enter a 4-digit year");
    const n = Number(v);
    if (n < 1950 || n > new Date().getUTCFullYear() + 6) return fail("Year out of range");
    return ok(v);
  },

  percentage(raw) {
    const v = raw.replace("%", "").trim();
    const n = Number(v);
    if (v === "" || Number.isNaN(n) || n < 0 || n > 100) return fail("Percentage must be between 0 and 100");
    return ok(String(Math.round(n * 100) / 100));
  },

  cgpa(raw) {
    const n = Number(raw.trim());
    if (raw.trim() === "" || Number.isNaN(n) || n < 0 || n > 10) return fail("CGPA must be between 0 and 10");
    return ok(String(Math.round(n * 100) / 100));
  },

  number(raw, opts) {
    const v = raw.replace(/,/g, "").trim();
    const n = Number(v);
    if (v === "" || Number.isNaN(n)) return fail("Enter a number");
    if (opts?.min !== undefined && n < opts.min) return fail(`Must be at least ${opts.min}`);
    if (opts?.max !== undefined && n > opts.max) return fail(`Must be at most ${opts.max}`);
    return ok(String(n));
  },

  pan(raw) {
    const v = raw.replace(/\s/g, "").toUpperCase();
    if (!/^[A-Z]{3}[ABCFGHLJPTK][A-Z]\d{4}[A-Z]$/.test(v)) return fail("Invalid PAN format (e.g. ABCDE1234F)");
    return ok(v);
  },

  aadhaar(raw) {
    const v = raw.replace(/[\s-]/g, "");
    if (!/^[2-9]\d{11}$/.test(v)) return fail("Aadhaar must be 12 digits and cannot start with 0 or 1");
    if (!verhoeffValid(v)) return fail("Aadhaar checksum is invalid");
    return ok(v);
  },

  ifsc(raw) {
    const v = raw.replace(/\s/g, "").toUpperCase();
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(v)) return fail("Invalid IFSC (e.g. SBIN0001234)");
    return ok(v);
  },

  bank_account(raw) {
    const v = raw.replace(/\s/g, "");
    if (!/^\d{9,18}$/.test(v)) return fail("Account number must be 9–18 digits");
    return ok(v);
  },

  passport_in(raw) {
    const v = raw.replace(/\s/g, "").toUpperCase();
    if (!/^[A-PR-WY][1-9]\d{6}$/.test(v)) return fail("Invalid Indian passport number");
    return ok(v);
  },

  voter_id(raw) {
    const v = raw.replace(/\s/g, "").toUpperCase();
    if (!/^[A-Z]{3}\d{7}$/.test(v)) return fail("Invalid voter ID (EPIC) format");
    return ok(v);
  },

  driving_license_in(raw) {
    const v = raw.replace(/[\s-]/g, "").toUpperCase();
    if (!/^[A-Z]{2}\d{2}\d{4}\d{7}$/.test(v)) return fail("Invalid driving licence number");
    return ok(v);
  },

  yes_no(raw) {
    const v = raw.trim().toLowerCase();
    if (["yes", "y", "true", "haan", "हाँ", "हां"].includes(v)) return ok("yes");
    if (["no", "n", "false", "nahi", "नहीं"].includes(v)) return ok("no");
    return fail("Answer yes or no");
  },

  select(raw, opts) {
    const v = trimmed(raw);
    const options = opts?.options ?? [];
    const found = options.find((o) => o.toLowerCase() === v.toLowerCase());
    if (!found) return fail(`Choose one of: ${options.join(", ")}`);
    return ok(found);
  },
} satisfies Record<string, Validator>;

export type ValidatorName = keyof typeof validators;

export function validateValue(name: ValidatorName, raw: string, opts?: ValidatorOptions): ValidationResult {
  return validators[name](raw, opts);
}
