#!/usr/bin/env node
/**
 * Static server for the local test form website (no dependencies).
 *   npm run test-form        -> http://localhost:4000         the test recruitment form
 *                               http://localhost:4000/spa     single-page-app demo
 *                               http://localhost:4000/__dev/harness   side panel + form side by side (dev only)
 *
 * Dev-only extras (development tooling, never part of the extension or the product):
 *  - /__dev/detector.js : the extension's detector without chrome.* APIs
 *  - /__dev/ext/*       : the built side panel, with a chrome.* shim injected
 *  - /__dev/session     : signs in the local dev test user from .data/dev-test-user.json (created by
 *                         scripts/seed-dev-user.mjs) so the harness needs no typed password. Loopback only.
 *  - /__dev/dashboard   : same, but signs the dev user in to the web dashboard (session cookie; cookies on
 *                         localhost are shared across ports) and redirects there. Loopback only.
 *                         With ?as=cafe / ?as=admin the seeded café owner / admin is used; if the dev admin has
 *                         two-step verification (seed-dev-admin.mjs --mfa) the code comes from its stored secret.
 *  - /api/*             : proxied to the app (TEST_FORM_API, default http://localhost:3000) the way the
 *                         extension calls it: Origin chrome-extension://…, no cookies.
 */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import path from "node:path";
import { devTotp } from "../../scripts/dev-totp.mjs";

const here = import.meta.dirname;
const publicDir = path.join(here, "public");
const extDist = path.join(here, "../extension/dist");
const harnessDir = path.join(here, "dev-harness");
const PORT = Number(process.env.TEST_FORM_PORT ?? 4000);
const API = new URL(process.env.TEST_FORM_API ?? "http://localhost:3000");
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

function inside(base, rel) {
  const full = path.resolve(base, rel);
  return full.startsWith(base + path.sep) ? full : null;
}

function proxy(req, res) {
  const headers = { ...req.headers, host: API.host, origin: "chrome-extension://devharnessdevharnessdevharness" };
  delete headers.cookie;
  delete headers.referer;
  const up = httpRequest({ hostname: API.hostname, port: API.port, path: req.url, method: req.method, headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => res.writeHead(502, { "Content-Type": "application/json" }).end('{"error":{"message":"App server not running"}}'));
  req.pipe(up);
}

const isLoopback = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");

/** Dev harness sign-in with the seeded test user; the password never reaches the browser. */
const DEV_ACCOUNTS = { cafe: "dev-cafe-owner.json", admin: "dev-admin.json" };
const devCredsFile = (req) =>
  path.resolve(here, "../../.data", DEV_ACCOUNTS[new URL(req.url ?? "/", "http://localhost").searchParams.get("as")] ?? "dev-test-user.json");

/** Password step, then (dev admin with 2FA) the authenticator step from the stored dev secret. */
async function devLogin(creds, origin, client) {
  const post = (p, body) =>
    fetch(new URL(p, API), { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ ...body, client }) });
  const r = await post("/api/auth/login", { email: creds.email, password: creds.password });
  if (!r.ok || !creds.totpSecret) return r;
  const body = await r.clone().json();
  if (!body.mfaRequired) return r;
  return post("/api/auth/login/mfa", { mfaToken: body.mfaToken, code: devTotp(creds.totpSecret) });
}

async function devSession(req, res) {
  const credsFile = devCredsFile(req);
  if (!isLoopback(req) || !existsSync(credsFile)) {
    res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":{"message":"Run node scripts/seed-dev-user.mjs first"}}');
    return;
  }
  const creds = JSON.parse(readFileSync(credsFile, "utf8"));
  try {
    const r = await devLogin(creds, "chrome-extension://devharnessdevharnessdevharness", "extension");
    const body = await r.json();
    res.writeHead(r.status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(r.ok ? { token: body.token, expiresAt: body.expiresAt } : body));
  } catch {
    res.writeHead(502, { "Content-Type": "application/json" }).end('{"error":{"message":"App server not running"}}');
  }
}

/** Dev-only: dashboard sign-in as the seeded test user, then redirect to the app. */
async function devDashboard(req, res) {
  const credsFile = devCredsFile(req);
  if (!isLoopback(req) || !existsSync(credsFile)) {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Run node scripts/seed-dev-user.mjs first");
    return;
  }
  const creds = JSON.parse(readFileSync(credsFile, "utf8"));
  try {
    const r = await devLogin(creds, API.origin, "web");
    const cookie = r.headers.get("set-cookie");
    if (!r.ok || !cookie) {
      res.writeHead(502, { "Content-Type": "text/plain" }).end(`Dev login failed (HTTP ${r.status})`);
      return;
    }
    res.writeHead(302, { "Set-Cookie": cookie, Location: new URL("/dashboard", API).href, "Cache-Control": "no-store" }).end();
  } catch {
    res.writeHead(502, { "Content-Type": "text/plain" }).end("App server not running");
  }
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname.startsWith("/api/")) return proxy(req, res);
  if (url.pathname === "/__dev/session" && req.method === "POST") return void devSession(req, res);
  if (url.pathname === "/__dev/dashboard") return void devDashboard(req, res);

  let file = null;
  if (url.pathname === "/__dev/detector.js") file = path.join(extDist, "detector.js");
  else if (url.pathname === "/__dev/harness") file = path.join(harnessDir, "harness.html");
  else if (url.pathname === "/__dev/chrome-shim.js") file = path.join(harnessDir, "chrome-shim.js");
  else if (url.pathname === "/__dev/ext/sidepanel.html") {
    const htmlPath = path.join(extDist, "sidepanel.html");
    if (existsSync(htmlPath)) {
      const html = readFileSync(htmlPath, "utf8").replace('<script src="sidepanel.js">', '<script src="/__dev/chrome-shim.js"></script><script src="sidepanel.js">');
      res.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-store" }).end(html);
      return;
    }
  } else if (url.pathname.startsWith("/__dev/ext/")) file = inside(extDist, url.pathname.slice("/__dev/ext/".length));
  else if (url.pathname.startsWith("/spa")) file = path.join(publicDir, "spa.html");
  else file = inside(publicDir, url.pathname === "/" ? "index.html" : url.pathname.slice(1));

  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  createReadStream(file).pipe(res);
}).listen(PORT, () => console.info(`Test form site: http://localhost:${PORT}  (SPA demo: /spa · dev harness: /__dev/harness)`));
