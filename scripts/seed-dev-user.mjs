/**
 * DEV ONLY: creates a test customer with sample profile data on a local server,
 * for trying the extension against apps/test-form. The generated credentials are
 * written to .data/dev-test-user.json (git-ignored) and never printed.
 *
 *   npm run dev            (server on http://localhost:3000)
 *   node scripts/seed-dev-user.mjs [baseUrl]
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const base = (process.argv[2] ?? "http://localhost:3000").replace(/\/+$/, "");
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) {
  console.error("Refusing: this script only talks to a local development server.");
  process.exit(1);
}
const file = ".data/dev-test-user.json";
const origin = { Origin: base, "Content-Type": "application/json" };

let creds;
if (existsSync(file)) creds = JSON.parse(readFileSync(file, "utf8"));
else {
  creds = { email: `dev.${randomBytes(3).toString("hex")}@example.test`, password: `Dev${randomBytes(9).toString("base64url")}9` };
  const r = await fetch(`${base}/api/auth/signup`, { method: "POST", headers: origin, body: JSON.stringify({ fullName: "Ramesh Kumar", email: creds.email, password: creds.password }) });
  if (!r.ok) throw new Error(`signup failed: HTTP ${r.status}`);
  mkdirSync(".data", { recursive: true });
  writeFileSync(file, JSON.stringify(creds, null, 2));
}

const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: origin, body: JSON.stringify({ ...creds, client: "extension" }) });
if (!login.ok) throw new Error(`login failed: HTTP ${login.status}`);
const { token } = await login.json();
const auth = { ...origin, Authorization: `Bearer ${token}` };

const profile = {
  "personal.full_name": "Ramesh Kumar",
  "personal.date_of_birth": "2001-04-09",
  "personal.gender": "Male",
  "personal.marital_status": "Unmarried",
  "recruitment.category": "General",
  "family.father_name": "Suresh Kumar",
  "family.mother_name": "Sunita Devi",
  "family.guardian_name": "Ramesh Chandra",
  "contact.mobile": "9876543210",
  "contact.email": creds.email,
  "contact.address_line_1": "12 Gandhi Nagar, Patna",
  "contact.pincode": "800001",
  "contact.country": "India",
  "contact.state": "Bihar",
};
let saved = 0;
for (const [key, value] of Object.entries(profile)) {
  const r = await fetch(`${base}/api/profile/fields`, { method: "PUT", headers: auth, body: JSON.stringify({ fieldKey: key, value }) });
  if (r.ok) saved++;
  else console.warn(`  ${key}: HTTP ${r.status} ${(await r.json().catch(() => ({})))?.error?.message ?? ""}`);
}
await fetch(`${base}/api/auth/logout`, { method: "POST", headers: auth });
console.log(`Dev test user ready (${saved} profile fields). Credentials: ${file}`);
