import type { Sql } from "@ufa/db";
import { DEFAULT_PROMOTION_POLICY, promotionDecision, type Metrics, type PromotionPolicy } from "./metrics";

/**
 * Model registry operations shared by the CLI (`npm run ml`) and the admin
 * dashboard, so both apply exactly the same promotion gate. Registry changes
 * never deploy anything: serving is switched by setting LOCAL_AI_MODEL.
 */
export class RegistryError extends Error {
  constructor(
    message: string,
    public reasons: string[] = [],
  ) {
    super(message);
  }
}

export async function latestTestMetrics(sql: Sql, modelName: string, datasetId: string): Promise<Metrics | null> {
  const [r] = await sql<{ metrics: Metrics }[]>`
    select metrics from model_evaluations where model_name = ${modelName} and dataset_id = ${datasetId} and split = 'test'
     order by created_at desc limit 1`;
  return r?.metrics ?? null;
}

export interface PromotionResult {
  name: string;
  to: "STAGING" | "PRODUCTION";
  servingName: string | null;
  replaced: string | null;
}

export async function promoteModel(
  sql: Sql,
  input: { name: string; to: "STAGING" | "PRODUCTION"; policy?: PromotionPolicy; actorId?: string | null; actorRole?: string | null },
): Promise<PromotionResult> {
  const [m] = await sql<{ id: string; status: string; dataset_id: string | null; serving_name: string | null }[]>`
    select id, status, dataset_id, serving_name from model_versions where name = ${input.name}`;
  if (!m) throw new RegistryError(`No model named ${input.name}`);
  if (["RETIRED", "FAILED", "DISABLED"].includes(m.status) && input.to === "STAGING") throw new RegistryError(`${input.name} is ${m.status.toLowerCase()}`);
  if (m.status === "PRODUCTION") throw new RegistryError(`${input.name} is already in production`);
  if (!m.dataset_id) throw new RegistryError("The model has no dataset");
  const cand = await latestTestMetrics(sql, input.name, m.dataset_id);
  if (!cand) throw new RegistryError(`Evaluate ${input.name} on its dataset's test split first`);

  if (input.to === "STAGING") {
    await sql.begin(async (tx) => {
      await tx`update model_versions set status = 'STAGING' where id = ${m.id}`;
      await tx`insert into audit_logs (actor_id, actor_role, action, target_type, target_id, metadata)
               values (${input.actorId ?? null}, ${input.actorRole ?? null}, 'ml.model_staged', 'model_version', ${m.id}, ${tx.json({ name: input.name })})`;
    });
    return { name: input.name, to: "STAGING", servingName: m.serving_name, replaced: null };
  }

  const [prod] = await sql<{ id: string; name: string }[]>`select id, name from model_versions where status = 'PRODUCTION'`;
  let prodMetrics: Metrics | null = null;
  if (prod) {
    prodMetrics = await latestTestMetrics(sql, prod.name, m.dataset_id);
    if (!prodMetrics) throw new RegistryError(`Evaluate the current production model "${prod.name}" on the same dataset first (fair comparison)`);
  }
  const decision = promotionDecision(cand, prodMetrics, input.policy ?? DEFAULT_PROMOTION_POLICY);
  if (!decision.ok) throw new RegistryError("Not promoted", decision.reasons);

  await sql.begin(async (tx) => {
    if (prod) await tx`update model_versions set status = 'RETIRED', retired_at = now() where id = ${prod.id}`;
    await tx`update model_versions set status = 'PRODUCTION', promoted_at = now(), promoted_by = ${input.actorId ?? null},
                                       previous_production_id = ${prod?.id ?? null}, retired_at = null
              where id = ${m.id}`;
    await tx`insert into audit_logs (actor_id, actor_role, action, target_type, target_id, metadata)
             values (${input.actorId ?? null}, ${input.actorRole ?? null}, 'ml.model_promoted', 'model_version', ${m.id}, ${tx.json({ name: input.name, previous: prod?.name ?? null })})`;
  });
  return { name: input.name, to: "PRODUCTION", servingName: m.serving_name, replaced: prod?.name ?? null };
}

export async function rollbackModel(sql: Sql, actor: { actorId?: string | null; actorRole?: string | null } = {}): Promise<{ from: string; to: string; servingName: string | null }> {
  const [cur] = await sql<{ id: string; name: string; previous_production_id: string | null }[]>`
    select id, name, previous_production_id from model_versions where status = 'PRODUCTION'`;
  if (!cur?.previous_production_id) throw new RegistryError("No production model with a previous version to roll back to");
  const [prev] = await sql<{ name: string; serving_name: string | null }[]>`select name, serving_name from model_versions where id = ${cur.previous_production_id}`;
  await sql.begin(async (tx) => {
    await tx`update model_versions set status = 'RETIRED', retired_at = now() where id = ${cur.id}`;
    await tx`update model_versions set status = 'PRODUCTION', retired_at = null where id = ${cur.previous_production_id}`;
    await tx`insert into audit_logs (actor_id, actor_role, action, target_type, target_id, metadata)
             values (${actor.actorId ?? null}, ${actor.actorRole ?? null}, 'ml.model_rolled_back', 'model_version', ${cur.id}, ${tx.json({ from: cur.name, to: prev?.name ?? null })})`;
  });
  return { from: cur.name, to: prev?.name ?? "?", servingName: prev?.serving_name ?? null };
}

/** Takes a model out of consideration (never touches the production row). */
export async function disableModel(sql: Sql, name: string, actor: { actorId?: string | null; actorRole?: string | null } = {}) {
  const rows = await sql<{ id: string }[]>`
    update model_versions set status = 'DISABLED' where name = ${name} and status not in ('PRODUCTION', 'DISABLED') returning id`;
  if (!rows.length) throw new RegistryError(`${name} cannot be disabled (unknown, in production, or already disabled)`);
  await sql`insert into audit_logs (actor_id, actor_role, action, target_type, target_id, metadata)
            values (${actor.actorId ?? null}, ${actor.actorRole ?? null}, 'ml.model_disabled', 'model_version', ${rows[0]!.id}, ${sql.json({ name })})`;
}
