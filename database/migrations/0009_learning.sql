-- Phase 9: learning engine.
--
-- Learning uses structure only (labels, sections, input types, field signatures,
-- target profile keys) — never values. Shared knowledge (WEBSITE / GLOBAL
-- form_mappings) is written only by the server's learning job (system pool),
-- and only when enough *different* users agree.

-- Every field signature of a form version (visible and hidden): lets us tell a
-- user "this form changed since you last applied" (fields added / removed).
alter table form_signatures add column if not exists field_signatures text[] not null default '{}';

-- Structure of each confirmed field, so a successful fill can become a learning
-- example and strengthen the mapping (page-local field id, signature, section).
alter table application_fields
  add column if not exists field_ref text,
  add column if not exists field_signature text,
  add column if not exists section text,
  add column if not exists language text;

-- Users can opt out of contributing to shared (anonymised) patterns.
alter table profiles add column if not exists learning_contribution_enabled boolean not null default true;

-- Users can forget their own learned mappings.
grant delete on form_mappings to ufa_app;
create policy form_mappings_user_delete on form_mappings for delete to ufa_app
  using (scope = 'USER' and user_id = app.current_user_id());

-- Examples: searchable by contributor/label for dedupe and withdrawal.
alter table learning_examples
  add column if not exists field_signature text,
  add column if not exists normalized_label text;
create index if not exists learning_examples_dedupe_idx
  on learning_examples (contributor_user_id, domain, normalized_label, profile_field_key, source);

-- One row per promotion run (system only: RLS on, no policies for the runtime role).
create table if not exists learning_runs (
  id                  uuid primary key default gen_random_uuid(),
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  votes               integer not null default 0,
  website_promoted    integer not null default 0,
  global_promoted     integer not null default 0,
  demoted             integer not null default 0,
  error               text
);
alter table learning_runs enable row level security;

create index if not exists form_mappings_scope_idx on form_mappings (scope, verified);
