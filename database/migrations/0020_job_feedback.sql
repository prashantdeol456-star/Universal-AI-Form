-- AI browser Phase 4 (step 10): user feedback on job matching.
--
-- job_feedback: "was this match useful?" votes and corrections of requirements read from
-- one job description. job_ranking_rules: preferences the user wrote (or approved from a
-- vote) that re-order jobs. Rules never change the fit score itself: they add a separate,
-- bounded adjustment stored next to it. Everything is user-scoped, reviewable and deletable;
-- nothing trains a model.

create table job_feedback (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  job_id      uuid references job_listings (id) on delete cascade,
  kind        text not null check (kind in ('match_useful', 'requirement_correction')),
  useful      boolean,
  target      text check (target in ('required_skill', 'preferred_skill', 'experience_min_years', 'education_level')),
  action      text check (action in ('add', 'remove', 'set')),
  value       text check (value is null or length(value) between 1 and 100),
  reason      text check (reason is null or length(reason) <= 500),
  created_at  timestamptz not null default now(),
  check (
    (kind = 'match_useful' and useful is not null and target is null and action is null and value is null)
    or (kind = 'requirement_correction' and job_id is not null and useful is null and target is not null and action is not null and value is not null)
  )
);
create index job_feedback_user_idx on job_feedback (user_id, created_at desc);
create index job_feedback_job_idx on job_feedback (job_id) where job_id is not null;
create trigger job_feedback_owner before insert or update on job_feedback for each row execute function app.job_ref_same_owner();

create table job_ranking_rules (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users (id) on delete cascade,
  kind                text not null check (kind in ('employer', 'keyword', 'skill', 'title_word')),
  value               text not null check (length(value) between 1 and 100),
  weight              smallint not null check (weight between -10 and 10 and weight <> 0),
  reason              text check (reason is null or length(reason) <= 500),
  -- The vote this rule was made from, when the user turned feedback into a rule.
  source_feedback_id  uuid references job_feedback (id) on delete set null,
  created_at          timestamptz not null default now()
);
create unique index job_ranking_rules_uniq on job_ranking_rules (user_id, kind, lower(value));

create or replace function app.job_rule_feedback_same_owner() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if new.source_feedback_id is not null and not exists (select 1 from job_feedback f where f.id = new.source_feedback_id and f.user_id = new.user_id) then
    raise exception 'feedback belongs to another user';
  end if;
  return new;
end $$;
create trigger job_ranking_rules_owner before insert or update on job_ranking_rules for each row execute function app.job_rule_feedback_same_owner();

-- The ordering adjustment from the user's rules, kept apart from the fit score.
alter table job_matches
  add column rank_adjustment smallint not null default 0 check (rank_adjustment between -20 and 20),
  add column rank_explanation jsonb not null default '[]' check (jsonb_typeof(rank_explanation) = 'array' and pg_column_size(rank_explanation) <= 8192);

do $$
declare t text;
begin
  foreach t in array array['job_feedback', 'job_ranking_rules'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy %I on %I for all to ufa_app using (user_id = app.current_user_id()) with check (user_id = app.current_user_id())', t || '_own', t);
  end loop;
end $$;

-- Feedback can be reviewed and deleted, not rewritten.
grant select, insert, delete on job_feedback to ufa_app;
grant select, insert, update, delete on job_ranking_rules to ufa_app;
