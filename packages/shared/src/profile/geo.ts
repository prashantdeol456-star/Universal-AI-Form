/** Indian states and union territories, for recognising them in free text (documents, chat). */
export const INDIAN_STATES = [
  "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa", "Gujarat", "Haryana", "Himachal Pradesh",
  "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland",
  "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand",
  "West Bengal", "Delhi", "Jammu and Kashmir", "Ladakh", "Chandigarh", "Puducherry",
  "Andaman and Nicobar Islands", "Dadra and Nagar Haveli and Daman and Diu", "Lakshadweep",
];

export function findState(text: string): string | null {
  let best: { name: string; idx: number } | null = null;
  for (const s of INDIAN_STATES) {
    const re = new RegExp(`\\b${s.replace(/ /g, "\\s+")}\\b`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) if (!best || m.index > best.idx) best = { name: s, idx: m.index };
  }
  return best?.name ?? null;
}

