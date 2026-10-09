/**
 * DEV ONLY: creates a local SUPER_ADMIN with a generated password via the normal
 * `create-admin` CLI. Credentials go to .data/dev-admin.json (git-ignored) and are
 * never printed. Then: http://localhost:4000/__dev/dashboard?as=admin
 *
 *   node scripts/seed-dev-admin.mjs
 *   node scripts/seed-dev-admin.mjs --mfa [--base http://localhost:3000]
 *
 * Admin pages require two-step verification (ADMIN_REQUIRE_MFA). `--mfa` turns it on
 * for the dev admin through the normal API (app must be running) and keeps the TOTP
 * secret in the same git-ignored file, so the /__dev/dashboard sign-in can answer
 * the second step itself. Recovery codes are discarded.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { devTotp } from "./dev-totp.mjs";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing: development helper only.");
  process.exit(1);
}
const file = ".data/dev-admin.json";
let creds;
if (existsSync(file)) creds = JSON.parse(readFileSync(file, "utf8"));
else {
  creds = { email: `admin.${randomBytes(3).toString("hex")}@example.test`, password: `Adm${randomBytes(12).toString("base64url")}5` };
  mkdirSync(".data", { recursive: true });
  writeFileSync(file, JSON.stringify(creds, null, 2));
}
const r = spawnSync("npx", ["tsx", "packages/db/src/cli.ts", "create-admin"], {
  env: { ...process.env, ADMIN_EMAIL: creds.email, ADMIN_PASSWORD: creds.password, ADMIN_NAME: "Dev Admin" },
  stdio: ["ignore", "ignore", "inherit"],
  shell: true,
});
if (r.status !== 0) process.exit(r.status ?? 1);

if (process.argv.includes("--mfa") && !creds.totpSecret) {
  const i = process.argv.indexOf("--base");
  const base = (i > 0 ? process.argv[i + 1] : process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const call = async (path, body, cookie) => {
    const r = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${path} failed (HTTP ${r.status}): ${j.error?.message ?? ""}`);
    return { j, cookie: r.headers.get("set-cookie")?.split(";")[0] };
  };
  try {
    const { j: login, cookie } = await call("/api/auth/login", { email: creds.email, password: creds.password });
    if (login.mfaRequired) throw new Error("two-step verification is already on but the secret is not in the file; delete the dev admin and seed again");
    const { j: setup } = await call("/api/account/mfa", { action: "setup" }, cookie);
    await call("/api/account/mfa", { action: "enable", password: creds.password, code: devTotp(setup.secret) }, cookie);
    creds.totpSecret = setup.secret;
    writeFileSync(file, JSON.stringify(creds, null, 2));
    console.log("Two-step verification enabled for the dev admin.");
  } catch (e) {
    console.error(`--mfa: ${e.message}`);
    process.exit(1);
  }
}
console.log(`Dev admin ready. Credentials: ${file}`);
