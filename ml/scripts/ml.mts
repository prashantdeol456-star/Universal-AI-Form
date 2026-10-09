/* eslint-disable no-console -- a CLI prints to the terminal */
/**
 * ML pipeline CLI (phase 11). Runs on any machine that can reach the database;
 * training itself runs in Python on a GPU box (ml/training). Nothing here deploys
 * a model: promotion only changes the registry and tells you what to set.
 *
 *   npm run ml -- dataset   [--name mapping] [--seed s1] [--min-contributors 2] [--allow-small]
 *   npm run ml -- benchmark-dataset   (registers the hand-written benchmark as a frozen test set)
 *   npm run ml -- evaluate  --dataset <dir|benchmark> --model rules|ollama:<tag>|predictions:<file> [--name <registered model>]
 *   npm run ml -- register  --name <name> --base <hf model> --serving-name <ollama tag> --dataset <dir> [--adapter <path>] [--notes ...]
 *   npm run ml -- promote   --name <name> --to STAGING|PRODUCTION
 *   npm run ml -- rollback
 *   npm run ml -- list
 *   npm run ml -- vector-setup
 *   npm run ml -- embed-labels
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import {
  cleanExamples,
  computeMetrics,
  dedupeExamples,
  eligibleExamples,
  LOCAL_MAPPING_PROMPT_VERSION,
  LocalAIProvider,
  mapForm,
  NOT_A_PROFILE_FIELD,
  promoteModel,
  RegistryError,
  rollbackModel,
  referencePhrases,
  splitOf,
  toChatRecords,
  validateDataset,
  type Metrics,
  type Prediction,
  type RawExample,
  type Split,
} from "@ufa/ai";
import type { FieldKind, NormalizedField } from "@ufa/form-engine";
import { isCatalogKey, PROFILE_FIELDS } from "@ufa/shared";

const ROOT = path.resolve(import.meta.dirname, "../..");
if (existsSync(path.join(ROOT, ".env"))) process.loadEnvFile(path.join(ROOT, ".env"));

const [, , command, ...rest] = process.argv;
const args = new Map<string, string>();
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]!;
  if (a.startsWith("--")) {
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      args.set(a.slice(2), next);
      i++;
    } else args.set(a.slice(2), "true");
  }
}
const arg = (k: string, d?: string) => args.get(k) ?? d;
const need = (k: string) => {
  const v = args.get(k);
  if (!v) fail(`--${k} is required`);
  return v!;
};
function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const dbUrl = process.env.DATABASE_URL;
const sql = () => {
  if (!dbUrl) fail("DATABASE_URL is not set (.env)");
  return postgres(dbUrl, { max: 2, onnotice: () => {} });
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const candidates = PROFILE_FIELDS.map((d) => ({ key: d.key, label: d.label.en }));

interface TestField {
  id: string;
  label: string;
  section: string | null;
  type: string | null;
  options: string[];
  language: string;
  expected: string | null;
}

// --- dataset ------------------------------------------------------------------------------

async function buildDataset() {
  const db = sql();
  const name = arg("name", "mapping")!;
  const seed = arg("seed", `s${new Date().toISOString().slice(0, 10)}`)!;
  const minContributors = Number(arg("min-contributors", "2"));
  const rows = await db<{
    id: string; source: string; status: RawExample["status"]; contributor_user_id: string | null; domain: string | null;
    field_label: string; field_context: { section?: string | null; type?: string | null; options?: string[] }; language: string; profile_field_key: string;
  }[]>`
    select e.id, e.source, e.status, e.contributor_user_id, e.domain, e.field_label, e.field_context, e.language, e.profile_field_key
      from learning_examples e
      left join profiles p on p.user_id = e.contributor_user_id
     where e.status in ('PENDING', 'APPROVED')
       and (e.contributor_user_id is null or coalesce(p.learning_contribution_enabled, true))`;
  const raw: RawExample[] = rows.map((r) => ({
    id: r.id, source: r.source, status: r.status, contributorId: r.contributor_user_id, domain: r.domain, label: r.field_label,
    section: r.field_context?.section ?? null, type: r.field_context?.type ?? null, options: r.field_context?.options ?? [], language: r.language, key: r.profile_field_key,
  }));

  const { eligible, notEligible } = eligibleExamples(raw, minContributors);
  const { kept, dropped } = cleanExamples(eligible, isCatalogKey);
  const { examples, conflicts } = dedupeExamples(kept);
  const withSplit = examples.map((e) => ({ ...e, split: splitOf(e.normalizedLabel, seed) as Split }));
  const report = validateDataset(withSplit, { minExamples: args.has("allow-small") ? 1 : 50 });

  const [next] = await db<{ v: number }[]>`select coalesce(max(version), 0) + 1 as v from training_datasets where name = ${name}`;
  const v = next!.v;
  const dir = path.join(ROOT, "ml", "datasets", `${name}-v${v}`);
  mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = {};
  for (const split of ["train", "validation", "test"] as const) {
    const part = withSplit.filter((e) => e.split === split);
    const chat = toChatRecords(part, candidates, { seed, batchSize: 6 }).map((r) => JSON.stringify(r)).join("\n");
    writeFileSync(path.join(dir, `${split}.jsonl`), chat ? `${chat}\n` : "");
    files[`${split}.jsonl`] = sha(chat);
    // One row per field for evaluation (expected key or null for "none").
    const fields = part.map((e, i): TestField => ({
      id: `${split}-${i}`, label: e.label, section: e.section, type: e.type, options: e.options, language: e.language, expected: e.key === NOT_A_PROFILE_FIELD ? null : e.key,
    }));
    const fl = fields.map((f) => JSON.stringify(f)).join("\n");
    writeFileSync(path.join(dir, `${split}-fields.jsonl`), fl ? `${fl}\n` : "");
    files[`${split}-fields.jsonl`] = sha(fl);
  }
  const manifest = {
    name, version: v, seed, createdAt: new Date().toISOString(), promptVersion: LOCAL_MAPPING_PROMPT_VERSION, minContributors,
    sourceExamples: raw.length, notEligible, dropped, conflicts, report, files,
  };
  const manifestText = JSON.stringify(manifest, null, 2);
  writeFileSync(path.join(dir, "manifest.json"), manifestText);

  const status = report.errors.length ? "DRAFT" : "VALIDATED";
  const [ds] = await db<{ id: string }[]>`
    insert into training_datasets (name, version, status, example_count, storage_key, stats, manifest_sha256, source_filter)
    values (${name}, ${v}, ${status}, ${withSplit.length}, ${path.relative(ROOT, dir).replace(/\\/g, "/")}, ${db.json(JSON.parse(JSON.stringify(report)))},
            ${sha(manifestText)}, ${db.json({ minContributors, statuses: ["PENDING(consensus)", "APPROVED"] })})
    returning id`;
  for (const e of withSplit) for (const id of e.ids) await db`insert into training_dataset_examples (dataset_id, example_id, split) values (${ds!.id}, ${id}, ${e.split}) on conflict do nothing`;
  await db.end();

  console.log(`Dataset ${name} v${v} → ${path.relative(ROOT, dir)}  [${status}]`);
  console.log(`  ${raw.length} examples → ${eligible.length} eligible → ${kept.length} clean → ${withSplit.length} unique (${conflicts} conflicts dropped)`);
  console.log(`  splits: ${JSON.stringify(report.bySplit)} · languages: ${JSON.stringify(report.byLanguage)} · none: ${(report.noneShare * 100).toFixed(0)}%`);
  for (const w of report.warnings) console.log(`  ⚠ ${w}`);
  for (const e of report.errors) console.log(`  ✗ ${e}`);
  if (report.errors.length) process.exit(2);
}

/** The hand-written benchmark (packages/ai/src/mapping/benchmark.json) as a frozen, registered test set. */
async function benchmarkDataset() {
  const db = sql();
  const { fields } = loadFields("benchmark", "test");
  const [next] = await db<{ v: number }[]>`select coalesce(max(version), 0) + 1 as v from training_datasets where name = 'benchmark'`;
  const v = next!.v;
  const dir = path.join(ROOT, "ml", "datasets", `benchmark-v${v}`);
  mkdirSync(dir, { recursive: true });
  const fl = fields.map((f) => JSON.stringify({ ...f, id: f.id.replace(/^b-/, "test-") })).join("\n");
  writeFileSync(path.join(dir, "test-fields.jsonl"), `${fl}\n`);
  const manifest = { name: "benchmark", version: v, createdAt: new Date().toISOString(), promptVersion: LOCAL_MAPPING_PROMPT_VERSION, source: "packages/ai/src/mapping/benchmark.json", fields: fields.length };
  const text = JSON.stringify(manifest, null, 2);
  writeFileSync(path.join(dir, "manifest.json"), text);
  await db`
    insert into training_datasets (name, version, status, example_count, storage_key, stats, manifest_sha256, source_filter)
    values ('benchmark', ${v}, 'LOCKED', ${fields.length}, ${path.relative(ROOT, dir).replace(/\\/g, "/")}, ${db.json({ frozen: true })}, ${sha(text)}, ${db.json({ source: "benchmark.json" })})`;
  await db.end();
  console.log(`Frozen benchmark registered → ${path.relative(ROOT, dir)} (${fields.length} fields, LOCKED)`);
}

// --- evaluate -------------------------------------------------------------------------------

function loadFields(dataset: string, split: string): { fields: TestField[]; datasetDir: string | null } {
  if (dataset === "benchmark") {
    const items = JSON.parse(readFileSync(path.join(ROOT, "packages/ai/src/mapping/benchmark.json"), "utf8")) as Array<{ label: string; section?: string; kind?: string; options?: string[]; expected: string | null }>;
    return {
      datasetDir: null,
      fields: items.map((b, i) => ({ id: `b-${i}`, label: b.label, section: b.section ?? null, type: b.kind ?? "text", options: b.options ?? [], language: /[ऀ-ॿ]/.test(b.label) ? "hi" : "en", expected: b.expected })),
    };
  }
  const dir = path.resolve(ROOT, dataset);
  const file = path.join(dir, `${split}-fields.jsonl`);
  if (!existsSync(file)) fail(`${file} not found (build a dataset first)`);
  return { datasetDir: dir, fields: readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as TestField) };
}

const asNormalized = (f: TestField): NormalizedField => ({
  id: f.id, kind: (f.type ?? "text") as FieldKind, label: f.label, labelSource: "label", name: null, htmlId: null, placeholder: null, section: f.section,
  required: false, options: f.options, autocomplete: null, inputMode: null, maxLength: null, pattern: null, hint: null,
  language: f.language === "hi" ? "hi" : "en", visible: true, disabled: false, readOnly: false, hasValue: false, manual: null, accept: null,
  signature: "00000000", frame: "top", inShadowDom: false,
});

async function predict(model: string, fields: TestField[]): Promise<Prediction[]> {
  if (model === "rules") {
    // The deterministic engine alone (no knowledge base, no AI) with a complete profile.
    const profile = new Map(PROFILE_FIELDS.map((d) => [d.key, { value: "x", verified: true, sensitive: false }]));
    const res = await mapForm({ fields: fields.map(asNormalized), profile });
    return res.mappings.map((m, i) => ({
      id: fields[i]!.id, expected: fields[i]!.expected, predicted: m.decision === "MANUAL" ? null : m.profileFieldKey, confidence: m.confidence, language: fields[i]!.language,
    }));
  }
  if (model.startsWith("ollama:")) {
    const tag = model.slice("ollama:".length);
    const provider = new LocalAIProvider({ baseUrl: process.env.LOCAL_AI_BASE_URL ?? "http://localhost:11434", model: tag, apiKey: process.env.LOCAL_AI_API_KEY, timeoutMs: 300_000 });
    const out: Prediction[] = [];
    for (let i = 0; i < fields.length; i += 20) {
      const batch = fields.slice(i, i + 20);
      const r = await provider.mapFields({ fields: batch.map((f) => ({ id: f.id, label: f.label, section: f.section, kind: f.type ?? "text", options: f.options })), candidates });
      for (const f of batch) {
        const s = r.suggestions.find((x) => x.fieldId === f.id);
        out.push({ id: f.id, expected: f.expected, predicted: s?.profileField ?? null, confidence: s?.confidence ?? 0, language: f.language });
      }
      process.stdout.write(`\r  ${Math.min(i + 20, fields.length)}/${fields.length}`);
    }
    process.stdout.write("\n");
    return out;
  }
  if (model.startsWith("predictions:")) {
    const file = path.resolve(ROOT, model.slice("predictions:".length));
    const byId = new Map(
      readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => {
        const p = JSON.parse(l) as { id: string; predicted: string | null; confidence?: number };
        return [p.id, p] as const;
      }),
    );
    return fields.map((f) => {
      const p = byId.get(f.id);
      const key = p?.predicted && p.predicted !== "none" && isCatalogKey(p.predicted) ? p.predicted : null;
      return { id: f.id, expected: f.expected, predicted: key, confidence: p?.confidence ?? 0, language: f.language };
    });
  }
  fail(`Unknown --model ${model} (use rules, ollama:<tag> or predictions:<file>)`);
}

async function evaluate() {
  const dataset = need("dataset");
  const model = need("model");
  const split = arg("split", "test")!;
  const { fields, datasetDir } = loadFields(dataset, split);
  if (!fields.length) fail("No fields to evaluate");
  const metrics = computeMetrics(await predict(model, fields));
  const label = arg("name") ?? (model === "rules" ? "baseline:rules" : model);
  const outFile = datasetDir ? path.join(datasetDir, `eval-${label.replace(/[^\w.-]+/g, "_")}-${split}.json`) : path.join(ROOT, "ml", "evaluation", `benchmark-${label.replace(/[^\w.-]+/g, "_")}.json`);
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify({ model: label, dataset, split, evaluatedAt: new Date().toISOString(), metrics }, null, 2));

  if (datasetDir && dbUrl) {
    const db = sql();
    const rel = path.relative(ROOT, datasetDir).replace(/\\/g, "/");
    const [ds] = await db<{ id: string }[]>`select id from training_datasets where storage_key = ${rel}`;
    const [mv] = args.get("name") ? await db<{ id: string }[]>`select id from model_versions where name = ${args.get("name")!}` : [];
    await db`insert into model_evaluations (model_name, model_version_id, dataset_id, split, metrics)
             values (${label}, ${mv?.id ?? null}, ${ds?.id ?? null}, ${split === "validation" ? "validation" : "test"}, ${db.json(JSON.parse(JSON.stringify(metrics)))})`;
    await db.end();
  }
  printMetrics(label, metrics);
  console.log(`  → ${path.relative(ROOT, outFile)}`);
}

function printMetrics(label: string, m: Metrics) {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.log(`${label}: n=${m.n} · accuracy ${pct(m.accuracy)} · wrong ${pct(m.wrongRate)} · abstain ${pct(m.abstentionRate)} · precision ${pct(m.precision)} · recall ${pct(m.recall)} · macro-F1 ${m.macroF1.toFixed(3)} · ECE ${m.ece.toFixed(3)}`);
  for (const [lang, v] of Object.entries(m.perLanguage)) console.log(`  ${lang}: n=${v.n} accuracy ${pct(v.accuracy)} wrong ${pct(v.wrongRate)}`);
  for (const e of m.topErrors.slice(0, 5)) console.log(`  error ×${e.count}: ${e.expected} → ${e.predicted}`);
}

// --- registry -------------------------------------------------------------------------------

async function register() {
  const db = sql();
  const rel = path.relative(ROOT, path.resolve(ROOT, need("dataset"))).replace(/\\/g, "/");
  const [ds] = await db<{ id: string; status: string }[]>`select id, status from training_datasets where storage_key = ${rel}`;
  if (!ds) fail(`Dataset ${rel} is not registered (build it with "npm run ml -- dataset")`);
  await db`update training_datasets set status = 'LOCKED' where id = ${ds.id} and status = 'VALIDATED'`;
  const [m] = await db<{ id: string }[]>`
    insert into model_versions (name, base_model, adapter_path, dataset_id, status, serving_name, notes)
    values (${need("name")}, ${need("base")}, ${arg("adapter") ?? null}, ${ds.id}, 'EVALUATING', ${need("serving-name")}, ${arg("notes") ?? null})
    returning id`;
  await db.end();
  console.log(`Registered ${need("name")} (${m!.id}) on dataset ${rel} — dataset is now LOCKED. Evaluate it next:`);
  console.log(`  npm run ml -- evaluate --dataset ${rel} --model ollama:${need("serving-name")} --name ${need("name")}`);
}

const policy = () => ({
  maxWrongRate: Number(process.env.ML_MAX_WRONG_RATE ?? 0.02),
  minAccuracyGain: Number(process.env.ML_MIN_ACCURACY_GAIN ?? 0),
  minTestSize: Number(process.env.ML_MIN_TEST_SIZE ?? 50),
});

async function promote() {
  const db = sql();
  const name = need("name");
  const to = need("to").toUpperCase();
  if (to !== "STAGING" && to !== "PRODUCTION") fail("--to must be STAGING or PRODUCTION");
  try {
    const r = await promoteModel(db, { name, to, policy: policy(), actorRole: "CLI" });
    if (r.to === "STAGING") console.log(`${name} → STAGING. Try it with LOCAL_AI_MODEL=${r.servingName} on a staging server.`);
    else {
      console.log(`✓ ${name} is now PRODUCTION in the registry${r.replaced ? ` (replacing ${r.replaced})` : ""}.`);
      console.log(`  Nothing was deployed. To serve it: set LOCAL_AI_MODEL=${r.servingName} in .env and restart the web container.`);
    }
  } catch (err) {
    if (err instanceof RegistryError) fail(err.reasons.length ? `${err.message}:\n  - ${err.reasons.join("\n  - ")}` : err.message);
    throw err;
  } finally {
    await db.end();
  }
}

async function rollback() {
  const db = sql();
  try {
    const r = await rollbackModel(db, { actorRole: "CLI" });
    console.log(`✓ Rolled back ${r.from} → ${r.to}. Set LOCAL_AI_MODEL=${r.servingName} and restart the web container.`);
  } catch (err) {
    if (err instanceof RegistryError) fail(err.message);
    throw err;
  } finally {
    await db.end();
  }
}

async function list() {
  const db = sql();
  const ds = await db<{ name: string; version: number; status: string; example_count: number; storage_key: string | null; created_at: Date }[]>`
    select name, version, status, example_count, storage_key, created_at from training_datasets order by created_at desc limit 20`;
  const ms = await db<{ name: string; status: string; base_model: string; serving_name: string | null; promoted_at: Date | null }[]>`
    select name, status, base_model, serving_name, promoted_at from model_versions order by created_at desc limit 20`;
  const ev = await db<{ model_name: string; split: string; metrics: Metrics; created_at: Date }[]>`
    select model_name, split, metrics, created_at from model_evaluations order by created_at desc limit 10`;
  await db.end();
  console.log("Datasets:");
  for (const d of ds) console.log(`  ${d.name} v${d.version}  ${d.status.padEnd(9)} ${String(d.example_count).padStart(6)} examples  ${d.storage_key ?? ""}`);
  console.log("Models:");
  for (const m of ms) console.log(`  ${m.name.padEnd(28)} ${m.status.padEnd(10)} ${m.serving_name ?? "-"}  (${m.base_model})`);
  console.log("Recent evaluations:");
  for (const e of ev) console.log(`  ${e.model_name.padEnd(28)} ${e.split.padEnd(10)} acc ${(e.metrics.accuracy * 100).toFixed(1)}%  wrong ${(e.metrics.wrongRate * 100).toFixed(1)}%  n=${e.metrics.n}`);
}

// --- pgvector -----------------------------------------------------------------------------

async function vectorSetup() {
  const db = sql();
  const [avail] = await db<{ ok: boolean }[]>`select exists (select 1 from pg_available_extensions where name = 'vector') as ok`;
  if (!avail?.ok) {
    await db.end();
    fail("pgvector is not installed on this PostgreSQL server (the production image pgvector/pgvector:pg16 has it). Semantic search keeps working in-process.");
  }
  const ddl = readFileSync(path.join(ROOT, "database/migrations/0011_ml_pipeline.sql"), "utf8");
  await db.unsafe(ddl.slice(ddl.indexOf("do $$")));
  await db.end();
  console.log("✓ pgvector label table ready (label_embeddings).");
}

async function embedLabels() {
  const embedModel = process.env.LOCAL_AI_EMBED_MODEL;
  if (!embedModel) fail("Set LOCAL_AI_EMBED_MODEL (e.g. nomic-embed-text) and run Ollama");
  const db = sql();
  const [t] = await db<{ ok: boolean }[]>`select to_regclass('label_embeddings') is not null as ok`;
  if (!t?.ok) fail('label_embeddings does not exist (pgvector missing). Run "npm run ml -- vector-setup" on a server with pgvector.');
  const provider = new LocalAIProvider({ baseUrl: process.env.LOCAL_AI_BASE_URL ?? "http://localhost:11434", model: process.env.LOCAL_AI_MODEL ?? "none", embedModel, apiKey: process.env.LOCAL_AI_API_KEY, timeoutMs: 300_000 });
  // Shared, verified knowledge only — never a user's personal mappings.
  const shared = await db<{ normalized_label: string; profile_field_key: string; scope: string }[]>`
    select distinct normalized_label, profile_field_key, lower(scope) as scope from form_mappings
     where scope in ('GLOBAL', 'WEBSITE') and verified and profile_field_key <> ${NOT_A_PROFILE_FIELD}`;
  const items = [
    ...referencePhrases().map((p) => ({ text: p.text, key: p.fieldKey, source: "catalog" })),
    ...shared.map((s) => ({ text: s.normalized_label, key: s.profile_field_key, source: s.scope })),
  ];
  let done = 0;
  for (let i = 0; i < items.length; i += 64) {
    const batch = items.slice(i, i + 64);
    const vectors = await provider.embed(batch.map((b) => b.text));
    if (vectors[0]?.length !== 768) fail(`Embedding model returns ${vectors[0]?.length} dimensions; label_embeddings expects 768 (nomic-embed-text)`);
    for (let j = 0; j < batch.length; j++) {
      await db`
        insert into label_embeddings (normalized_label, profile_field_key, source, model, embedding)
        values (${batch[j]!.text}, ${batch[j]!.key}, ${batch[j]!.source}, ${embedModel}, ${`[${vectors[j]!.join(",")}]`}::vector)
        on conflict (normalized_label, profile_field_key, model) do update set embedding = excluded.embedding, source = excluded.source`;
    }
    done += batch.length;
    process.stdout.write(`\r  ${done}/${items.length}`);
  }
  await db.end();
  console.log(`\n✓ Embedded ${done} labels with ${embedModel}.`);
}

const commands: Record<string, () => Promise<unknown>> = {
  dataset: buildDataset,
  "benchmark-dataset": benchmarkDataset,
  evaluate,
  register,
  promote,
  rollback,
  list,
  "vector-setup": vectorSetup,
  "embed-labels": embedLabels,
};
const run = command ? commands[command] : undefined;
if (!run) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]!.replace(/^\/\*\*?|^ \* ?/gm, ""));
  process.exit(command ? 1 : 0);
}
await run();
