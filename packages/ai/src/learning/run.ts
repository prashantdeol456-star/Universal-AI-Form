import type { Sql } from "@ufa/db";
import { decidePromotions, voteFromUserMapping, type LearningConfig, type MappingVote, DEFAULT_LEARNING_CONFIG } from "./promotion";

/**
 * Runs one learning pass against the database (system / owner connection: it
 * writes shared knowledge, which the runtime role cannot). Safe to call from
 * several processes at once — a transaction-scoped advisory lock lets only one
 * run at a time, the others return `skipped`.
 *
 * Only users who allow contributions are counted. Rows created by this job are
 * marked `verification_source = 'learning'`; when the evidence no longer holds
 * they are demoted (verified = false), never deleted. Admin-verified rows are
 * never touched.
 */

export interface LearningRunResult {
  skipped: boolean;
  votes: number;
  websitePromoted: number;
  globalPromoted: number;
  demoted: number;
}

const LOCK_KEY = 0x55464131; // "UFA1"

export async function runLearning(sql: Sql, cfg: LearningConfig = DEFAULT_LEARNING_CONFIG): Promise<LearningRunResult> {
  const [run] = await sql<{ id: string }[]>`insert into learning_runs default values returning id`;
  try {
    const result = await sql.begin(async (tx) => {
      const [lock] = await tx<{ ok: boolean }[]>`select pg_try_advisory_xact_lock(${LOCK_KEY}) as ok`;
      if (!lock?.ok) return { skipped: true, votes: 0, websitePromoted: 0, globalPromoted: 0, demoted: 0 };

      const rows = await tx<Parameters<typeof voteFromUserMapping>[0][]>`
        select fm.user_id, fm.domain, fm.field_signature, fm.field_label, fm.normalized_label, fm.profile_field_key,
               fm.verified, fm.success_count, fm.failure_count
          from form_mappings fm
          join profiles p on p.user_id = fm.user_id and p.learning_contribution_enabled
          join users u on u.id = fm.user_id and u.status = 'ACTIVE'
         where fm.scope = 'USER'`;
      const votes = rows.map(voteFromUserMapping).filter((v): v is MappingVote => v !== null);
      const promotions = decidePromotions(votes, cfg);

      const kept: string[] = [];
      for (const p of promotions) {
        const [row] = await tx<{ id: string }[]>`
          insert into form_mappings (scope, user_id, domain, field_signature, field_label, normalized_label, language, profile_field_key,
                                     verified, verification_source, success_count, failure_count, last_verified_at)
          values (${p.scope}, null, ${p.domain}, ${p.fieldSignature}, ${p.fieldLabel.slice(0, 200)}, ${p.normalizedLabel.slice(0, 200)},
                  ${/[ऀ-ॿ]/.test(p.fieldLabel) ? "hi" : "en"}, ${p.key}, true, 'learning', ${p.support}, ${p.against}, now())
          on conflict (scope, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(domain, ''), field_signature, profile_field_key)
          do update set
            verified = case when form_mappings.verification_source in ('learning', 'learning_demoted') then true else form_mappings.verified end,
            verification_source = case when form_mappings.verification_source in ('learning', 'learning_demoted') then 'learning' else form_mappings.verification_source end,
            success_count = excluded.success_count,
            failure_count = excluded.failure_count,
            last_verified_at = now()
          returning id`;
        kept.push(row!.id);
      }

      // Evidence that no longer holds (users disagreed, withdrew or were deleted): demote.
      const demoted = await tx`
        update form_mappings set verified = false, verification_source = 'learning_demoted'
         where scope in ('WEBSITE', 'GLOBAL') and verification_source = 'learning' and verified
           ${kept.length ? tx`and id not in ${tx(kept)}` : tx``}
        returning id`;

      return {
        skipped: false,
        votes: votes.length,
        websitePromoted: promotions.filter((p) => p.scope === "WEBSITE").length,
        globalPromoted: promotions.filter((p) => p.scope === "GLOBAL").length,
        demoted: demoted.length,
      };
    });
    await sql`
      update learning_runs set finished_at = now(), votes = ${result.votes}, website_promoted = ${result.websitePromoted},
             global_promoted = ${result.globalPromoted}, demoted = ${result.demoted}, error = ${result.skipped ? "skipped: another run in progress" : null}
       where id = ${run!.id}`;
    return result;
  } catch (err) {
    await sql`update learning_runs set finished_at = now(), error = ${String(err instanceof Error ? err.message : err).slice(0, 500)} where id = ${run!.id}`;
    throw err;
  }
}
