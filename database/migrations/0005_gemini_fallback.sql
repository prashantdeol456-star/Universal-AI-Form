-- =============================================================================
-- 0005_gemini_fallback.sql — Phase 6: cloud AI fallback, cache, tracking, opt-out
-- =============================================================================

-- Shared cache of fallback answers (spec §68). The key is built only from a field's
-- structure (normalized label, section, input type, option labels) — never user data —
-- so one user's Gemini call can answer the same field for everyone.
-- Written and read by the server's system pool only.
create table ai_mapping_cache (
  cache_key          text primary key,
  provider           text not null,
  model              text not null,
  profile_field_key  text,               -- null = the model answered "none"
  confidence         numeric(4, 3),
  hits               integer not null default 0,
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null
);
create index ai_mapping_cache_expiry_idx on ai_mapping_cache (expires_at);
alter table ai_mapping_cache enable row level security;  -- no policies: runtime role has no access

-- Per-field fallback suggestions (spec §30): what was asked, what came back, and
-- whether the user later confirmed or corrected it.
create table ai_field_suggestions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users (id) on delete cascade,
  ai_request_id      uuid references ai_requests (id) on delete set null,
  provider           text not null,
  model              text,
  domain             text not null,
  field_signature    text not null,
  suggested_key      text,
  confidence         numeric(4, 3),
  from_cache         boolean not null default false,
  user_confirmed     boolean,
  user_corrected     boolean,
  final_key          text,
  created_at         timestamptz not null default now(),
  resolved_at        timestamptz
);
create index ai_field_suggestions_lookup on ai_field_suggestions (user_id, domain, field_signature, created_at desc);

alter table ai_field_suggestions enable row level security;
create policy ai_field_suggestions_owner on ai_field_suggestions for all to ufa_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
grant select, insert on ai_field_suggestions to ufa_app;
grant update (user_confirmed, user_corrected, final_key, resolved_at) on ai_field_suggestions to ufa_app;

-- How many fields a call covered (cost analytics).
alter table ai_requests add column items integer;

-- User control over third-party AI (spec §66/§85). Default on: only labels are sent.
alter table profiles add column cloud_ai_enabled boolean not null default true;
