#!/usr/bin/env node
/**
 * Small, dependency-free load test (phase 13). Fires concurrent requests for a
 * fixed time and reports throughput and latency percentiles.
 *
 *   node scripts/load-test.mjs --base http://localhost:3000 --path /api/health -c 20 -d 15
 *   node scripts/load-test.mjs --base http://localhost:3000 --scenario map -c 10 -d 20 --login .data/dev-test-user.json
 *
 * Scenarios: health (GET /api/health), map (POST /api/extension/forms/map with the
 * test form's snapshot — needs --login <creds.json> for a bearer token).
 * Only point it at servers you run yourself.
 */
import { readFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("-")) acc.push([a.replace(/^-+/, ""), all[i + 1] && !all[i + 1].startsWith("-") ? all[i + 1] : "true"]);
    return acc;
  }, []),
);
const base = (args.base ?? "http://localhost:3000").replace(/\/$/, "");
const concurrency = Number(args.c ?? args.concurrency ?? 10);
const seconds = Number(args.d ?? args.duration ?? 10);
const scenario = args.scenario ?? (args.path ? "custom" : "health");
const origin = "chrome-extension://loadtestloadtestloadtestloadtest";

async function token() {
  if (!args.login) throw new Error("--login <creds.json> is required for this scenario");
  const { email, password } = JSON.parse(readFileSync(args.login, "utf8"));
  const r = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ email, password, client: "extension" }) });
  const j = await r.json();
  if (!j.token) throw new Error(`login failed (HTTP ${r.status}${j.mfaRequired ? ", account uses two-step verification" : ""})`);
  return j.token;
}

function snapshot() {
  // A realistic 30-field form: the test recruitment form's field list.
  const fields = [
    ["Candidate Full Name", "text", "Personal Details"], ["Name as per Matriculation Certificate", "text", "Personal Details"], ["Father's Name", "text", "Personal Details"],
    ["Mother's Name", "text", "Personal Details"], ["Date of Birth", "date", "Personal Details"], ["Gender", "radio", "Personal Details"], ["Marital Status", "select", "Personal Details"],
    ["पिता का नाम", "text", "अन्य विवरण"], ["स्थायी पता", "textarea", "अन्य विवरण"], ["Mobile Number", "tel", "Contact Details"], ["Email ID", "email", "Contact Details"],
    ["PIN Code", "text", "Contact Details"], ["Country", "select", "Contact Details"], ["State", "select", "Contact Details"], ["Category", "select", "Category & Eligibility"],
    ["Are you an Ex-Serviceman?", "radio", "Category & Eligibility"], ["Experience (in years)", "number", "Category & Eligibility"], ["Highest Qualification", "combobox", "Category & Eligibility"],
    ["Year of Passing", "text", "Category & Eligibility"], ["Name", "text", "Guardian Details"], ["Father / Guardian Name", "text", "Guardian Details"],
  ].map(([label, kind, section], i) => ({
    id: `f${i + 1}`, kind, label, labelSource: "label", name: `n${i}`, htmlId: null, placeholder: null, section, required: false,
    options: kind === "select" || kind === "radio" ? ["UR", "OBC", "SC"] : [], autocomplete: null, inputMode: null, maxLength: null, pattern: null, hint: null,
    language: /[ऀ-ॿ]/.test(label) ? "hi" : "en", visible: true, disabled: false, readOnly: false, hasValue: false, manual: null, accept: null,
    signature: (0x10000000 + i).toString(16), frame: "top", inShadowDom: false,
  }));
  return {
    url: "http://localhost:4000/", domain: "localhost", pageTitle: "Load test form", formTitle: "Load test form", fields, sections: [],
    formSignature: "abcdef01", structureHash: "abcdef02", warnings: [], detectedAt: new Date().toISOString(),
  };
}

async function main() {
  let request;
  if (scenario === "map") {
    const t = await token();
    const body = JSON.stringify(snapshot());
    request = () => fetch(`${base}/api/extension/forms/map`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Authorization: `Bearer ${t}` }, body });
  } else {
    const path = scenario === "health" ? "/api/health" : args.path;
    request = () => fetch(`${base}${path}`);
  }

  const latencies = [];
  const okLatencies = [];
  const statuses = new Map();
  let errors = 0;
  const end = Date.now() + seconds * 1000;
  const worker = async () => {
    while (Date.now() < end) {
      const t0 = performance.now();
      try {
        const r = await request();
        await r.arrayBuffer();
        statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
        if (r.status < 300) okLatencies.push(performance.now() - t0);
      } catch {
        errors++;
      }
      latencies.push(performance.now() - t0);
    }
  };
  const started = Date.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsed = (Date.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  okLatencies.sort((a, b) => a - b);
  const pct = (arr, q) => arr[Math.min(arr.length - 1, Math.floor(q * arr.length))]?.toFixed(1) ?? "-";
  const p = (q) => pct(latencies, q);
  console.info(
    JSON.stringify(
      {
        scenario, base, concurrency, seconds: Math.round(elapsed),
        requests: latencies.length, rps: Math.round(latencies.length / elapsed),
        latency_ms: { p50: p(0.5), p90: p(0.9), p95: p(0.95), p99: p(0.99), max: latencies.at(-1)?.toFixed(1) },
        successLatency_ms: { n: okLatencies.length, p50: pct(okLatencies, 0.5), p95: pct(okLatencies, 0.95), max: okLatencies.at(-1)?.toFixed(1) },
        statuses: Object.fromEntries(statuses), networkErrors: errors,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
