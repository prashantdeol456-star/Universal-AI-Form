-- AI browser Phase 4: job discovery, matching and application tracking.
--
-- Everything is per user (forced RLS, owner-only): the boards a user follows, the listings
-- found for them, their fit scores, saved jobs, applications and preferences. Listings hold
-- only public job-page data (no recruiter contact details are extracted). Unknown values
-- stay NULL, never 0 or ''. Application statuses are changed by the user only; the
-- tracker never learns "applied" from a form fill.

create table job_sources (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users (id) on delete cascade,
  source_type      text not null check (source_type in ('greenhouse', 'lever')),
  source_key       text not null check (source_key ~ '^[a-z0-9][a-z0-9_-]{0,79}$'),
  region           text not null default 'global' check (region in ('global', 'eu')),
  display_name     text check (display_name is null or length(display_name) <= 200),
  last_fetched_at  timestamptz,
  last_status      text not null default 'never'
                   check (last_status in ('never', 'ok', 'error', 'rate_limited', 'not_found')),
  last_error       text check (last_error is null or length(last_error) <= 300),
  job_count        integer not null default 0 check (job_count >= 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, source_type, source_key, region)
);
create trigger job_sources_updated_at before update on job_sources for each row execute function app.set_updated_at();

create table job_listings (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references users (id) on delete cascade,
  source_id             uuid references job_sources (id) on delete set null,
  source_type           text not null check (source_type in ('greenhouse', 'lever', 'manual')),
  source_key            text,
  provider_job_id       text check (provider_job_id is null or length(provider_job_id) <= 80),
  title                 text not null check (length(title) between 1 and 300),
  employer              text check (employer is null or length(employer) <= 200),
  location              text check (location is null or length(location) <= 300),
  work_arrangement      text check (work_arrangement in ('remote', 'hybrid', 'onsite')),
  employment_type       text check (employment_type is null or length(employment_type) <= 80),
  description           text not null default '' check (length(description) <= 30000),
  required_skills       text[] not null default '{}' check (cardinality(required_skills) <= 100),
  preferred_skills      text[] not null default '{}' check (cardinality(preferred_skills) <= 100),
  mentioned_skills      text[] not null default '{}' check (cardinality(mentioned_skills) <= 100),
  experience_min_years  numeric(4, 1) check (experience_min_years is null or experience_min_years between 0 and 60),
  experience_text       text check (experience_text is null or length(experience_text) <= 300),
  education_level       text check (education_level in ('diploma', 'bachelor', 'master', 'phd')),
  education_required    boolean,
  requirements_structured boolean not null default false,
  -- Salary only from a provider's structured pay field (salary_source names it); never parsed from text.
  salary_min            numeric(14, 2) check (salary_min is null or salary_min >= 0),
  salary_max            numeric(14, 2) check (salary_max is null or salary_max >= 0),
  salary_currency       text check (salary_currency is null or salary_currency ~ '^[A-Z]{3}$'),
  salary_period         text check (salary_period is null or length(salary_period) <= 30),
  salary_source         text check (salary_source is null or length(salary_source) <= 60),
  canonical_url         text not null check (canonical_url ~ '^https://' and length(canonical_url) <= 2000),
  apply_url             text check (apply_url is null or (apply_url ~ '^https://' and length(apply_url) <= 2000)),
  published_at          timestamptz,
  provider_updated_at   timestamptz,
  retrieved_at          timestamptz not null default now(),
  last_seen_at          timestamptz not null default now(),
  -- open: listed at the source on the last refresh; closed: no longer listed there;
  -- unknown: a manual job (nobody re-checks it).
  status                text not null default 'open' check (status in ('open', 'closed', 'unknown')),
  source_metadata       jsonb not null default '{}' check (jsonb_typeof(source_metadata) = 'object' and pg_column_size(source_metadata) <= 4096),
  -- AI summary of the public job text (labelled as AI-generated in the UI).
  ai_analysis           jsonb check (ai_analysis is null or pg_column_size(ai_analysis) <= 32768),
  ai_analyzed_at        timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (salary_min is null or salary_max is null or salary_min <= salary_max),
  check ((salary_min is null and salary_max is null) or (salary_currency is not null and salary_source is not null)),
  unique (user_id, canonical_url)
);
create unique index job_listings_provider_uniq on job_listings (user_id, source_type, source_key, provider_job_id) where provider_job_id is not null;
create index job_listings_user_recent_idx on job_listings (user_id, retrieved_at desc, id);
create index job_listings_source_idx on job_listings (source_id) where source_id is not null;
create trigger job_listings_updated_at before update on job_listings for each row execute function app.set_updated_at();

create table job_matches (
  job_id        uuid primary key references job_listings (id) on delete cascade,
  user_id       uuid not null references users (id) on delete cascade,
  score         smallint check (score is null or score between 0 and 100),
  provisional   boolean not null,
  explanation   jsonb not null check (pg_column_size(explanation) <= 65536),
  computed_at   timestamptz not null default now()
);
create index job_matches_user_score_idx on job_matches (user_id, score desc nulls last);

create table job_saves (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users (id) on delete cascade,
  job_id       uuid not null references job_listings (id) on delete cascade,
  notes        text check (notes is null or length(notes) <= 4000),
  priority     smallint not null default 2 check (priority between 1 and 3),
  shortlisted  boolean not null default false,
  saved_at     timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, job_id)
);
create trigger job_saves_updated_at before update on job_saves for each row execute function app.set_updated_at();

create table job_applications (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references users (id) on delete cascade,
  -- Null when the listing was removed; title/employer/url keep the user's reference.
  job_id            uuid references job_listings (id) on delete set null,
  title             text not null check (length(title) between 1 and 300),
  employer          text check (employer is null or length(employer) <= 200),
  job_url           text check (job_url is null or (job_url ~ '^https://' and length(job_url) <= 2000)),
  application_url   text check (application_url is null or (application_url ~ '^https://' and length(application_url) <= 2000)),
  status            text not null default 'interested' check (status in (
                      'interested', 'shortlisted', 'preparing', 'ready_for_review', 'applied',
                      'assessment', 'interview', 'offer', 'rejected', 'withdrawn', 'closed')),
  -- Set only when the user confirmed they submitted the application themselves.
  submitted_confirmed_at timestamptz,
  deadline          date,
  next_follow_up    date,
  notes             text check (notes is null or length(notes) <= 4000),
  last_activity_at  timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (status not in ('applied', 'assessment', 'interview', 'offer') or submitted_confirmed_at is not null)
);
create unique index job_applications_job_uniq on job_applications (user_id, job_id) where job_id is not null;
create index job_applications_user_idx on job_applications (user_id, last_activity_at desc);
create trigger job_applications_updated_at before update on job_applications for each row execute function app.set_updated_at();

-- Activity history: what changed and when (no note text).
create table job_application_events (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users (id) on delete cascade,
  application_id   uuid not null references job_applications (id) on delete cascade,
  kind             text not null check (kind in ('created', 'status', 'deadline', 'follow_up', 'notes', 'fill_linked')),
  from_status      text,
  to_status        text,
  created_at       timestamptz not null default now()
);
create index job_application_events_app_idx on job_application_events (application_id, created_at desc);

create table job_preferences (
  user_id             uuid primary key references users (id) on delete cascade,
  roles               text[] not null default '{}' check (cardinality(roles) <= 20),
  locations           text[] not null default '{}' check (cardinality(locations) <= 20),
  work_arrangements   text[] not null default '{}' check (work_arrangements <@ array['remote', 'hybrid', 'onsite']::text[]),
  employment_types    text[] not null default '{}' check (cardinality(employment_types) <= 10),
  industries          text[] not null default '{}' check (cardinality(industries) <= 20),
  experience_min      numeric(4, 1) check (experience_min is null or experience_min between 0 and 60),
  experience_max      numeric(4, 1) check (experience_max is null or experience_max between 0 and 60),
  salary_min          numeric(14, 2) check (salary_min is null or salary_min >= 0),
  salary_max          numeric(14, 2) check (salary_max is null or salary_max >= 0),
  salary_currency     text check (salary_currency is null or salary_currency ~ '^[A-Z]{3}$'),
  updated_at          timestamptz not null default now(),
  check (experience_min is null or experience_max is null or experience_min <= experience_max),
  check (salary_min is null or salary_max is null or salary_min <= salary_max)
);
create trigger job_preferences_updated_at before update on job_preferences for each row execute function app.set_updated_at();

-- Rows that point at a listing or application must belong to the same user.
-- (security definer: the check must see the referenced row even though RLS hides other users' rows.)
create or replace function app.job_ref_same_owner() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if new.job_id is not null and not exists (select 1 from job_listings j where j.id = new.job_id and j.user_id = new.user_id) then
    raise exception 'job belongs to another user';
  end if;
  return new;
end $$;
create or replace function app.job_source_same_owner() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if new.source_id is not null and not exists (select 1 from job_sources s where s.id = new.source_id and s.user_id = new.user_id) then
    raise exception 'job source belongs to another user';
  end if;
  return new;
end $$;
create or replace function app.job_application_same_owner() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if not exists (select 1 from job_applications a where a.id = new.application_id and a.user_id = new.user_id) then
    raise exception 'application belongs to another user';
  end if;
  return new;
end $$;
create trigger job_listings_owner before insert or update on job_listings for each row execute function app.job_source_same_owner();
create trigger job_matches_owner before insert or update on job_matches for each row execute function app.job_ref_same_owner();
create trigger job_saves_owner before insert or update on job_saves for each row execute function app.job_ref_same_owner();
create trigger job_applications_owner before insert or update on job_applications for each row execute function app.job_ref_same_owner();
create trigger job_application_events_owner before insert on job_application_events for each row execute function app.job_application_same_owner();

do $$
declare t text;
begin
  foreach t in array array['job_sources', 'job_listings', 'job_matches', 'job_saves', 'job_applications', 'job_application_events', 'job_preferences'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy %I on %I for all to ufa_app using (user_id = app.current_user_id()) with check (user_id = app.current_user_id())', t || '_own', t);
  end loop;
end $$;

grant select, insert, update, delete on job_sources, job_listings, job_matches, job_saves, job_applications, job_preferences to ufa_app;
-- History is append-only for the app.
grant select, insert on job_application_events to ufa_app;
