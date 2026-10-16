import "server-only";
import { extractRequirements, mentions, matchJob, qualificationLevel, SKILL_LEXICON, type CandidateFacts, type Evidence, type JobPreferenceInput, type JobRequirements, type MatchResult, type WorkArrangement } from "@ufa/jobs";
import type { TransactionSql } from "@ufa/db";
import { asUser, decryptValue, type Actor } from "../db";
import { readStored } from "../documents/conflicts";

/**
 * The user's side of a job match, built once per request from their OWN records:
 *  - profile values (employment.skills, experience_years, highest_qualification, designation)
 *    with their confirmation state; an open conflict on a field makes it "not confirmed";
 *  - text of their processed documents (knowledge-base chunks, decrypted in memory only,
 *    bounded) to find skills written in a CV, cited by document and page.
 * Nothing is inferred from the job description about the user.
 */
const MAX_CHUNKS = 400;

const aliasesOf = (skill: string): string[] => {
  const lex = SKILL_LEXICON.find((s) => s.name.toLowerCase() === skill.toLowerCase());
  return lex ? lex.aliases : [skill.toLowerCase()];
};

export interface Candidate {
  facts: CandidateFacts;
  prefs: JobPreferenceInput;
  /** The user's own skill names (used to look for them in job descriptions too). */
  profileSkills: string[];
}

export async function loadCandidate(tx: TransactionSql, userId: string): Promise<Candidate> {
  const profile = await tx<{ field_key: string; value: string; is_encrypted: boolean; verified: boolean }[]>`
    select field_key, value, is_encrypted, verified from profile_fields
     where user_id = ${userId} and deleted_at is null
       and field_key in ('employment.skills', 'employment.experience_years', 'education.highest_qualification', 'employment.designation')`;
  const conflicts = new Set(
    (await tx<{ field_key: string }[]>`select field_key from document_conflicts where user_id = ${userId} and status = 'OPEN'`).map((r) => r.field_key),
  );
  const chunks = await tx<{ content_encrypted: string; page_number: number | null; document_id: string; title: string }[]>`
    select c.content_encrypted, c.page_number, c.document_id, coalesce(d.title, d.original_filename) as title
      from document_chunks c join documents d on d.id = c.document_id and d.deleted_at is null
     where c.user_id = ${userId}
     order by d.created_at desc, c.chunk_index
     limit ${MAX_CHUNKS}`;
  const [p] = await tx<{ roles: string[]; locations: string[]; work_arrangements: WorkArrangement[]; employment_types: string[] }[]>`
    select roles, locations, work_arrangements, employment_types from job_preferences where user_id = ${userId}`;

  const get = (key: string) => {
    const r = profile.find((x) => x.field_key === key);
    // A value whose sources disagree counts as not confirmed.
    return r ? { value: readStored(r), verified: r.verified && !conflicts.has(key) } : null;
  };
  const skills = get("employment.skills");
  const profileSkills = (skills?.value ?? "")
    .split(/[,;\n|•]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s.length <= 60);
  const docs = chunks.map((c) => ({ text: decryptValue(c.content_encrypted), page: c.page_number, documentId: c.document_id, title: c.title }));

  const cache = new Map<string, Evidence>();
  const skillEvidence = (skill: string): Evidence => {
    const key = skill.toLowerCase();
    const hit = cache.get(key);
    if (hit) return hit;
    const aliases = aliasesOf(skill);
    let ev: Evidence = { status: "missing", source: null };
    if (skills && aliases.some((a) => mentions(skills.value, a))) {
      ev = { status: skills.verified ? "verified" : "unconfirmed", source: `Profile: Key Skills${skills.verified ? " (confirmed)" : " (not confirmed)"}` };
    } else {
      const d = docs.find((x) => aliases.some((a) => mentions(x.text, a)));
      if (d) ev = { status: "document", source: `${d.title}${d.page ? `, page ${d.page}` : ""}`, documentId: d.documentId, page: d.page };
    }
    cache.set(key, ev);
    return ev;
  };

  const exp = get("employment.experience_years");
  const years = exp ? Number.parseFloat(exp.value) : NaN;
  const qual = get("education.highest_qualification");
  const designation = get("employment.designation");
  return {
    facts: {
      skillEvidence,
      experienceYears: exp && Number.isFinite(years) && years >= 0 && years <= 60 ? { value: years, verified: exp.verified, source: "Profile: Experience (years)" } : null,
      qualification: qual ? { level: qualificationLevel(qual.value), text: qual.value, verified: qual.verified, source: "Profile: Highest Qualification" } : null,
      designation: designation?.value ?? null,
    },
    prefs: { roles: p?.roles ?? [], locations: p?.locations ?? [], workArrangements: p?.work_arrangements ?? [], employmentTypes: p?.employment_types ?? [] },
    profileSkills,
  };
}

export interface JobRowForMatch {
  id: string;
  title: string;
  location: string | null;
  work_arrangement: WorkArrangement | null;
  employment_type: string | null;
  required_skills: string[];
  preferred_skills: string[];
  mentioned_skills: string[];
  experience_min_years: string | null;
  experience_text: string | null;
  education_level: "diploma" | "bachelor" | "master" | "phd" | null;
  education_required: boolean | null;
  requirements_structured: boolean;
}

export function requirementsOf(r: JobRowForMatch): JobRequirements {
  return {
    requiredSkills: r.required_skills,
    preferredSkills: r.preferred_skills,
    mentionedSkills: r.mentioned_skills,
    experienceMinYears: r.experience_min_years === null ? null : Number(r.experience_min_years),
    experienceText: r.experience_text,
    education: r.education_level ? { level: r.education_level, required: r.education_required ?? true, text: "" } : null,
    structured: r.requirements_structured,
  };
}

/** Computes and stores the fit score of the given jobs (all the user's jobs when omitted). */
export async function computeMatches(tx: TransactionSql, userId: string, candidate: Candidate, jobIds?: string[]): Promise<Map<string, MatchResult>> {
  const rows = await tx<JobRowForMatch[]>`
    select id, title, location, work_arrangement, employment_type, required_skills, preferred_skills, mentioned_skills,
           experience_min_years, experience_text, education_level, education_required, requirements_structured
      from job_listings where user_id = ${userId} ${jobIds ? tx`and id = any(${jobIds}::uuid[])` : tx``}
     limit 2000`;
  const out = new Map<string, MatchResult>();
  for (const r of rows) {
    const m = matchJob({ title: r.title, location: r.location, workArrangement: r.work_arrangement, employmentType: r.employment_type, requirements: requirementsOf(r) }, candidate.facts, candidate.prefs);
    out.set(r.id, m);
    await tx`
      insert into job_matches (job_id, user_id, score, provisional, explanation, computed_at)
      values (${r.id}, ${userId}, ${m.score}, ${m.provisional}, ${tx.json(m as never)}, now())
      on conflict (job_id) do update set score = excluded.score, provisional = excluded.provisional, explanation = excluded.explanation, computed_at = now()`;
  }
  return out;
}

/**
 * Re-reads every listing's requirements from its stored description (the user's own skills
 * may have changed, or the reader improved) and recomputes all fit scores.
 */
export async function rematchAll(actor: Actor): Promise<{ jobs: number }> {
  return asUser(actor, async (tx) => {
    const c = await loadCandidate(tx, actor.id);
    const rows = await tx<{ id: string; description: string }[]>`select id, description from job_listings where user_id = ${actor.id} limit 2000`;
    for (const r of rows) {
      const q = extractRequirements(r.description, c.profileSkills);
      await tx`
        update job_listings set required_skills = ${q.requiredSkills.slice(0, 100)}::text[], preferred_skills = ${q.preferredSkills.slice(0, 100)}::text[],
               mentioned_skills = ${q.mentionedSkills.slice(0, 100)}::text[], experience_min_years = ${q.experienceMinYears}, experience_text = ${q.experienceText},
               education_level = ${q.education?.level ?? null}, education_required = ${q.education ? q.education.required : null}, requirements_structured = ${q.structured}
         where id = ${r.id}`;
    }
    return { jobs: (await computeMatches(tx, actor.id, c)).size };
  });
}
