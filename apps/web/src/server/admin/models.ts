import "server-only";
import { disableModel, promoteModel, RegistryError, rollbackModel, type Metrics } from "@ufa/ai";
import { db, type Actor } from "../db";
import { HttpError } from "../http";
import { assertAdmin } from "./guard";

/** Datasets, models and their evaluations; promotion uses the same gate as the CLI. */
export interface AdminDataset {
  id: string;
  name: string;
  version: number;
  status: string;
  examples: number;
  path: string | null;
  warnings: string[];
  errors: string[];
  createdAt: string;
}

export interface AdminModel {
  id: string;
  name: string;
  status: string;
  baseModel: string;
  servingName: string | null;
  dataset: string | null;
  promotedAt: string | null;
  createdAt: string;
  metrics: Metrics | null;
  /** Production's metrics on the same dataset, for side-by-side comparison. */
  productionMetrics: Metrics | null;
}

export async function registry(actor: Actor): Promise<{ datasets: AdminDataset[]; models: AdminModel[]; baselines: Array<{ name: string; dataset: string | null; metrics: Metrics; at: string }> }> {
  assertAdmin(actor, "admin:models_manage");
  const sql = db().system;
  const ds = await sql<{ id: string; name: string; version: number; status: string; example_count: number; storage_key: string | null; stats: { warnings?: string[]; errors?: string[] }; created_at: Date }[]>`
    select id, name, version, status, example_count, storage_key, stats, created_at from training_datasets order by created_at desc limit 50`;
  const ms = await sql<{ id: string; name: string; status: string; base_model: string; serving_name: string | null; dataset_id: string | null; promoted_at: Date | null; created_at: Date }[]>`
    select id, name, status, base_model, serving_name, dataset_id, promoted_at, created_at from model_versions order by created_at desc limit 50`;
  const evals = await sql<{ model_name: string; dataset_id: string | null; metrics: Metrics; created_at: Date }[]>`
    select distinct on (model_name, dataset_id) model_name, dataset_id, metrics, created_at
      from model_evaluations where split = 'test' order by model_name, dataset_id, created_at desc`;
  const prod = ms.find((m) => m.status === "PRODUCTION");
  const dsName = (id: string | null) => {
    const d = ds.find((x) => x.id === id);
    return d ? `${d.name} v${d.version}` : null;
  };
  return {
    datasets: ds.map((d) => ({
      id: d.id, name: d.name, version: d.version, status: d.status, examples: d.example_count, path: d.storage_key,
      warnings: d.stats?.warnings ?? [], errors: d.stats?.errors ?? [], createdAt: d.created_at.toISOString(),
    })),
    models: ms.map((m) => ({
      id: m.id, name: m.name, status: m.status, baseModel: m.base_model, servingName: m.serving_name, dataset: dsName(m.dataset_id),
      promotedAt: m.promoted_at?.toISOString() ?? null, createdAt: m.created_at.toISOString(),
      metrics: evals.find((e) => e.model_name === m.name && e.dataset_id === m.dataset_id)?.metrics ?? null,
      productionMetrics: prod && prod.name !== m.name ? (evals.find((e) => e.model_name === prod.name && e.dataset_id === m.dataset_id)?.metrics ?? null) : null,
    })),
    baselines: evals.filter((e) => e.model_name.startsWith("baseline:")).map((e) => ({ name: e.model_name, dataset: dsName(e.dataset_id), metrics: e.metrics, at: e.created_at.toISOString() })),
  };
}

const asHttp = (err: unknown): never => {
  if (err instanceof RegistryError) throw new HttpError(409, "registry", err.reasons.length ? `${err.message}: ${err.reasons.join("; ")}` : err.message, { reasons: err.reasons });
  throw err;
};

export async function modelAction(actor: Actor, name: string, action: "stage" | "promote" | "rollback" | "disable") {
  assertAdmin(actor, "admin:models_manage");
  const sql = db().system;
  const who = { actorId: actor.id, actorRole: actor.role };
  try {
    if (action === "rollback") return { result: await rollbackModel(sql, who) };
    if (action === "disable") {
      await disableModel(sql, name, who);
      return { result: { disabled: name } };
    }
    return {
      result: await promoteModel(sql, {
        name,
        to: action === "stage" ? "STAGING" : "PRODUCTION",
        policy: {
          maxWrongRate: Number(process.env.ML_MAX_WRONG_RATE ?? 0.02),
          minAccuracyGain: Number(process.env.ML_MIN_ACCURACY_GAIN ?? 0),
          minTestSize: Number(process.env.ML_MIN_TEST_SIZE ?? 50),
        },
        ...who,
      }),
    };
  } catch (err) {
    return asHttp(err);
  }
}
