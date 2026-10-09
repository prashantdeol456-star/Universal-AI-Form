/**
 * DEV ONLY: creates a café owner account with a registered café on a local
 * server, for trying café mode. Credentials go to .data/dev-cafe-owner.json
 * (git-ignored) and are never printed. Then:
 *   http://localhost:4000/__dev/harness?as=cafe     side panel signed in as the café owner
 *   http://localhost:4000/__dev/dashboard?as=cafe   web dashboard as the café owner
 *
 *   node scripts/seed-dev-cafe.mjs [baseUrl]
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const base = (process.argv[2] ?? "http://localhost:3000").replace(/\/+$/, "");
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) {
  console.error("Refusing: this script only talks to a local development server.");
  process.exit(1);
}
const file = ".data/dev-cafe-owner.json";
const origin = { Origin: base, "Content-Type": "application/json" };

let creds;
if (existsSync(file)) creds = JSON.parse(readFileSync(file, "utf8"));
else {
  creds = { email: `cafe.${randomBytes(3).toString("hex")}@example.test`, password: `Cafe${randomBytes(9).toString("base64url")}7` };
  const r = await fetch(`${base}/api/auth/signup`, {
    method: "POST",
    headers: origin,
    body: JSON.stringify({ fullName: "Sharma Owner", email: creds.email, password: creds.password, accountType: "CAFE_OWNER" }),
  });
  if (!r.ok) throw new Error(`signup failed: HTTP ${r.status}`);
  mkdirSync(".data", { recursive: true });
  writeFileSync(file, JSON.stringify(creds, null, 2));
}

const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: origin, body: JSON.stringify({ ...creds, client: "extension" }) });
if (!login.ok) throw new Error(`login failed: HTTP ${login.status}`);
const { token } = await login.json();
const auth = { ...origin, Authorization: `Bearer ${token}` };

const mine = await (await fetch(`${base}/api/cafe`, { headers: auth })).json();
if (!mine.cafe) {
  const c = await fetch(`${base}/api/cafe`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Sharma Cyber Café (TEST)", city: "Patna", state: "Bihar", pincode: "800001" }) });
  if (!c.ok) throw new Error(`café creation failed: HTTP ${c.status}`);
}
await fetch(`${base}/api/auth/logout`, { method: "POST", headers: auth });
console.log(`Dev café owner ready. Credentials: ${file}`);
