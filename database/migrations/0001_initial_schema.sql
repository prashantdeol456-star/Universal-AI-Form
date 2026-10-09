-- =============================================================================
-- 0001_initial_schema.sql
-- Universal AI Form Assistant — core relational schema (self-hosted PostgreSQL 16)
--
-- Conventions
--   * UUID primary keys (gen_random_uuid, built into PG13+)
--   * created_at / updated_at on mutable tables (updated_at maintained by trigger)
--   * deleted_at = soft delete where user-facing deletion must be reversible/auditable
--   * Sensitive values (Aadhaar, PAN, bank, ...) are AES-256-GCM encrypted by the
--     application before insert; the column then holds ciphertext and is_encrypted = true.
--   * Row Level Security policies live in 0002_rls.sql.
-- =============================================================================

create extension if not exists citext;

create schema if not exists app;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
create or replace function app.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Enums (kept as CHECK constraints on text where future extension is likely,
-- as enums where the set is closed and referenced in policies)
-- -----------------------------------------------------------------------------
create type user_role as enum (
  'SUPER_ADMIN', 'CAFE_OWNER', 'CAFE_OPERATOR', 'CUSTOMER',
  'ENTERPRISE_ADMIN', 'ENTERPRISE_USER'
);

create type user_status as enum ('ACTIVE', 'SUSPENDED', 'DELETED');

-- -----------------------------------------------------------------------------
-- Identity & authentication (replaces Supabase Auth)
-- -----------------------------------------------------------------------------
create table users (
  id                 uuid primary key default gen_random_uuid(),
  email              citext not null,
  email_verified_at  timestamptz,
  password_hash      text,
  full_name          text not null check (char_length(full_name) between 1 and 200),
  mobile             text,
  role               user_role not null default 'CUSTOMER',
  status             user_status not null default 'ACTIVE',
  failed_login_count integer not null default 0,
  locked_until       timestamptz,
  last_login_at      timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);
create unique index users_email_key on users (email);
create index users_role_idx on users (role);
create trigger users_updated_at before update on users
  for each row execute function app.set_updated_at();

-- Opaque session tokens. Only the SHA-256 hash of the token is stored.
create table auth_sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users (id) on delete cascade,
  token_hash    text not null unique,
  client_type   text not null default 'web' check (client_type in ('web', 'extension')),
  user_agent    text,
  ip_address    text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz
);
create index auth_sessions_user_idx on auth_sessions (user_id);
create index auth_sessions_expires_idx on auth_sessions (expires_at);

-- One-time tokens: email verification OTP, password reset, login OTP.
create table auth_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users (id) on delete cascade,
  purpose      text not null check (purpose in ('EMAIL_VERIFY', 'PASSWORD_RESET', 'LOGIN_OTP')),
  token_hash   text not null,
  attempts     integer not null default 0,
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index auth_tokens_lookup_idx on auth_tokens (user_id, purpose) where consumed_at is null;
create index auth_tokens_hash_idx on auth_tokens (token_hash);

-- -----------------------------------------------------------------------------
-- Profile
-- -----------------------------------------------------------------------------
create table profiles (
  user_id             uuid primary key references users (id) on delete cascade,
  preferred_language  text not null default 'en' check (preferred_language in ('en', 'hi')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create trigger profiles_updated_at before update on profiles
  for each row execute function app.set_updated_at();

-- User-defined additional fields (field_key always starts with 'custom.')
create table profile_custom_fields (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users (id) on delete cascade,
  field_key     text not null check (field_key ~ '^custom\.[a-z0-9_]{1,60}$'),
  label         text not null check (char_length(label) between 1 and 120),
  data_type     text not null default 'text'
                check (data_type in ('text', 'number', 'date', 'boolean', 'select')),
  options       jsonb not null default '[]'::jsonb,
  is_sensitive  boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create unique index profile_custom_fields_key on profile_custom_fields (user_id, field_key)
  where deleted_at is null;
create trigger profile_custom_fields_updated_at before update on profile_custom_fields
  for each row execute function app.set_updated_at();

-- -----------------------------------------------------------------------------
-- Documents
-- -----------------------------------------------------------------------------
create table documents (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users (id) on delete cascade,
  document_type      text not null,
  title              text,
  storage_key        text not null,
  original_filename  text not null,
  mime_type          text not null,
  size_bytes         bigint not null check (size_bytes > 0),
  sha256             text not null,
  width_px           integer,
  height_px          integer,
  status             text not null default 'UPLOADED'
                     check (status in ('UPLOADED', 'PROCESSING', 'EXTRACTED', 'VERIFIED', 'FAILED')),
  expires_on         date,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);
create index documents_user_idx on documents (user_id) where deleted_at is null;
create unique index documents_dedupe on documents (user_id, sha256) where deleted_at is null;
create trigger documents_updated_at before update on documents
  for each row execute function app.set_updated_at();

create table document_extractions (
  id               uuid primary key default gen_random_uuid(),
  document_id      uuid not null references documents (id) on delete cascade,
  user_id          uuid not null references users (id) on delete cascade,
  field_key        text not null,
  extracted_value  text not null,
  is_encrypted     boolean not null default false,
  confidence       numeric(4, 3) check (confidence between 0 and 1),
  provider         text,
  model            text,
  status           text not null default 'PENDING'
                   check (status in ('PENDING', 'CONFIRMED', 'EDITED', 'REJECTED')),
  reviewed_at      timestamptz,
  created_at       timestamptz not null default now()
);
create index document_extractions_doc_idx on document_extractions (document_id);
create index document_extractions_user_idx on document_extractions (user_id, status);

-- -----------------------------------------------------------------------------
-- Chat
-- -----------------------------------------------------------------------------
create table chat_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  title       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index chat_sessions_user_idx on chat_sessions (user_id);
create trigger chat_sessions_updated_at before update on chat_sessions
  for each row execute function app.set_updated_at();

create table chat_messages (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references chat_sessions (id) on delete cascade,
  user_id     uuid not null references users (id) on delete cascade,
  role        text not null check (role in ('user', 'assistant', 'system')),
  content     text not null,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index chat_messages_session_idx on chat_messages (session_id, created_at);

-- -----------------------------------------------------------------------------
-- Profile field values with provenance
-- -----------------------------------------------------------------------------
create table profile_fields (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references users (id) on delete cascade,
  field_key               text not null check (field_key ~ '^[a-z_]+(\.[a-z0-9_]+)+$'),
  value                   text not null,
  is_encrypted            boolean not null default false,
  source                  text not null check (source in (
                            'user_input', 'chat', 'document', 'local_ai',
                            'gemini', 'application', 'admin')),
  verified                boolean not null default false,
  confidence              numeric(4, 3) check (confidence between 0 and 1),
  source_document_id      uuid references documents (id) on delete set null,
  source_chat_message_id  uuid references chat_messages (id) on delete set null,
  updated_by              uuid references users (id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  last_verified_at        timestamptz,
  deleted_at              timestamptz
);
create unique index profile_fields_user_key on profile_fields (user_id, field_key)
  where deleted_at is null;
create trigger profile_fields_updated_at before update on profile_fields
  for each row execute function app.set_updated_at();

-- Append-only audit trail of every value change.
create table profile_field_history (
  id                uuid primary key default gen_random_uuid(),
  profile_field_id  uuid references profile_fields (id) on delete set null,
  user_id           uuid not null references users (id) on delete cascade,
  field_key         text not null,
  old_value         text,
  new_value         text,
  is_encrypted      boolean not null default false,
  old_source        text,
  new_source        text,
  change_type       text not null check (change_type in ('CREATE', 'UPDATE', 'VERIFY', 'DELETE', 'CONFLICT_RESOLVED')),
  change_reason     text,
  changed_by        uuid references users (id) on delete set null,
  created_at        timestamptz not null default now()
);
create index profile_field_history_user_idx on profile_field_history (user_id, field_key, created_at desc);

-- Conflicting values for the same field (documents disagree, chat contradicts profile, ...)
create table document_conflicts (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users (id) on delete cascade,
  field_key        text not null,
  -- [{ "value": "<maybe-encrypted>", "is_encrypted": bool, "source": "...", "document_id": "...", "extraction_id": "..." }]
  candidates       jsonb not null,
  status           text not null default 'OPEN' check (status in ('OPEN', 'RESOLVED', 'DISMISSED')),
  resolved_value   text,
  resolved_source  text,
  resolved_by      uuid references users (id) on delete set null,
  resolved_at      timestamptz,
  created_at       timestamptz not null default now()
);
create index document_conflicts_open_idx on document_conflicts (user_id) where status = 'OPEN';

-- -----------------------------------------------------------------------------
-- Cyber café (multi-tenant)
-- -----------------------------------------------------------------------------
create table cafes (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 2 and 200),
  owner_id    uuid not null references users (id) on delete restrict,
  phone       text,
  address     text,
  city        text,
  state       text,
  pincode     text,
  status      text not null default 'ACTIVE' check (status in ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index cafes_owner_idx on cafes (owner_id);
create trigger cafes_updated_at before update on cafes
  for each row execute function app.set_updated_at();

create table cafe_users (
  id          uuid primary key default gen_random_uuid(),
  cafe_id     uuid not null references cafes (id) on delete cascade,
  user_id     uuid not null references users (id) on delete cascade,
  cafe_role   text not null check (cafe_role in ('OWNER', 'OPERATOR')),
  status      text not null default 'ACTIVE' check (status in ('ACTIVE', 'DISABLED')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (cafe_id, user_id)
);
create index cafe_users_user_idx on cafe_users (user_id);
create trigger cafe_users_updated_at before update on cafe_users
  for each row execute function app.set_updated_at();

create table cafe_customers (
  id           uuid primary key default gen_random_uuid(),
  cafe_id      uuid not null references cafes (id) on delete cascade,
  customer_id  uuid not null references users (id) on delete cascade,
  created_by   uuid references users (id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (cafe_id, customer_id)
);
create index cafe_customers_customer_idx on cafe_customers (customer_id);

-- Time-boxed, customer-approved access grant from a customer to one operator of one café.
create table cafe_sessions (
  id           uuid primary key default gen_random_uuid(),
  cafe_id      uuid not null references cafes (id) on delete cascade,
  customer_id  uuid not null references users (id) on delete cascade,
  operator_id  uuid not null references users (id) on delete cascade,
  purpose      text,
  status       text not null default 'PENDING'
               check (status in ('PENDING', 'ACTIVE', 'EXPIRED', 'REVOKED', 'REJECTED')),
  approved_at  timestamptz,
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  revoked_by   uuid references users (id) on delete set null,
  created_at   timestamptz not null default now()
);
create index cafe_sessions_customer_idx on cafe_sessions (customer_id, status);
create index cafe_sessions_operator_idx on cafe_sessions (operator_id, status);

-- Explicit per-category permissions of a café session. 'bank' is intentionally NOT grantable.
create table cafe_permissions (
  id               uuid primary key default gen_random_uuid(),
  cafe_session_id  uuid not null references cafe_sessions (id) on delete cascade,
  permission       text not null check (permission in (
                     'basic_profile', 'contact', 'family', 'education', 'employment',
                     'recruitment', 'identity', 'documents', 'applications', 'custom')),
  created_at       timestamptz not null default now(),
  unique (cafe_session_id, permission)
);

-- -----------------------------------------------------------------------------
-- Forms knowledge base
-- -----------------------------------------------------------------------------
create table form_signatures (
  id                    uuid primary key default gen_random_uuid(),
  domain                text not null,
  url_pattern           text,
  form_title            text,
  field_signature_hash  text not null,
  structure_hash        text,
  field_count           integer not null default 0,
  version               integer not null default 1,
  first_seen_at         timestamptz not null default now(),
  last_seen_at          timestamptz not null default now(),
  unique (domain, field_signature_hash)
);
create index form_signatures_domain_idx on form_signatures (domain);

create table form_mappings (
  id                   uuid primary key default gen_random_uuid(),
  scope                text not null check (scope in ('GLOBAL', 'WEBSITE', 'USER')),
  user_id              uuid references users (id) on delete cascade,
  domain               text,
  form_signature_id    uuid references form_signatures (id) on delete set null,
  field_signature      text not null,
  field_label          text not null,
  normalized_label     text not null,
  language             text not null default 'en',
  profile_field_key    text not null,
  verified             boolean not null default false,
  verification_source  text,
  success_count        integer not null default 0,
  failure_count        integer not null default 0,
  last_verified_at     timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check ((scope = 'USER') = (user_id is not null)),
  check ((scope = 'GLOBAL') or domain is not null or scope = 'USER')
);
create unique index form_mappings_unique on form_mappings (
  scope,
  coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(domain, ''),
  field_signature,
  profile_field_key
);
create index form_mappings_label_idx on form_mappings (normalized_label);
create trigger form_mappings_updated_at before update on form_mappings
  for each row execute function app.set_updated_at();

create table saved_forms (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users (id) on delete cascade,
  name               text not null,
  url                text not null,
  domain             text not null,
  form_signature_id  uuid references form_signatures (id) on delete set null,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);
create index saved_forms_user_idx on saved_forms (user_id) where deleted_at is null;
create trigger saved_forms_updated_at before update on saved_forms
  for each row execute function app.set_updated_at();

-- -----------------------------------------------------------------------------
-- Applications (immutable snapshots once confirmed)
-- -----------------------------------------------------------------------------
create table applications (
  id                  uuid primary key default gen_random_uuid(),
  customer_id         uuid not null references users (id) on delete cascade,
  cafe_id             uuid references cafes (id) on delete set null,
  operator_id         uuid references users (id) on delete set null,
  cafe_session_id     uuid references cafe_sessions (id) on delete set null,
  website_url         text not null,
  domain              text not null,
  organization        text,
  form_name           text,
  form_type           text,
  form_signature_id   uuid references form_signatures (id) on delete set null,
  application_number  text,
  status              text not null default 'DRAFT' check (status in (
                        'DRAFT', 'IN_PROGRESS', 'WAITING_FOR_USER', 'READY_FOR_REVIEW',
                        'CONFIRMED', 'SUBMITTED', 'FAILED', 'CANCELLED', 'ARCHIVED')),
  started_at          timestamptz not null default now(),
  confirmed_at        timestamptz,
  completed_at        timestamptz,
  submitted_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index applications_customer_idx on applications (customer_id, created_at desc);
create index applications_cafe_idx on applications (cafe_id, created_at desc) where cafe_id is not null;
create trigger applications_updated_at before update on applications
  for each row execute function app.set_updated_at();

create table application_fields (
  id                   uuid primary key default gen_random_uuid(),
  application_id       uuid not null references applications (id) on delete cascade,
  website_field_label  text not null,
  website_field_name   text,
  field_type           text,
  field_value          text,
  is_encrypted         boolean not null default false,
  profile_field_key    text,
  source               text,
  confidence           numeric(4, 3) check (confidence between 0 and 1),
  ai_provider          text,
  document_id          uuid references documents (id) on delete set null,
  verified             boolean not null default false,
  created_at           timestamptz not null default now()
);
create index application_fields_app_idx on application_fields (application_id);

create table application_documents (
  id                   uuid primary key default gen_random_uuid(),
  application_id       uuid not null references applications (id) on delete cascade,
  document_id          uuid not null references documents (id) on delete restrict,
  website_field_label  text,
  created_at           timestamptz not null default now(),
  unique (application_id, document_id, website_field_label)
);

create table application_events (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid not null references applications (id) on delete cascade,
  actor_id        uuid references users (id) on delete set null,
  event_type      text not null,
  details         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index application_events_app_idx on application_events (application_id, created_at);

-- Snapshot immutability: once an application is CONFIRMED/SUBMITTED/ARCHIVED its
-- field snapshot can no longer be changed (only cascade-deleted with the account).
create or replace function app.prevent_snapshot_mutation() returns trigger
language plpgsql as $$
declare
  v_status text;
  v_app_id uuid;
begin
  if tg_op = 'INSERT' then
    v_app_id := new.application_id;
  else
    v_app_id := old.application_id;
  end if;
  -- Account/data deletion (system job only) explicitly opts in to removing snapshots.
  if tg_op = 'DELETE' and current_setting('app.allow_snapshot_delete', true) = 'on' then
    return old;
  end if;
  select status into v_status from applications where id = v_app_id;
  if v_status in ('CONFIRMED', 'SUBMITTED', 'ARCHIVED') then
    raise exception 'application snapshot is immutable (status %)', v_status
      using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger application_fields_immutable
  before update or delete on application_fields
  for each row execute function app.prevent_snapshot_mutation();
create trigger application_fields_immutable_insert
  before insert on application_fields
  for each row execute function app.prevent_snapshot_mutation();

-- -----------------------------------------------------------------------------
-- AI usage & learning
-- -----------------------------------------------------------------------------
create table ai_requests (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references users (id) on delete set null,
  application_id    uuid references applications (id) on delete set null,
  provider          text not null,
  model             text,
  operation         text not null,
  decision          text check (decision in ('AUTO_FILL', 'USER_REVIEW', 'ASK_USER', 'GEMINI', 'MANUAL')),
  latency_ms        integer,
  success           boolean not null,
  error_code        text,
  confidence        numeric(4, 3),
  fallback_used     boolean not null default false,
  user_confirmed    boolean,
  user_corrected    boolean,
  input_tokens      integer,
  output_tokens     integer,
  created_at        timestamptz not null default now()
);
create index ai_requests_created_idx on ai_requests (created_at desc);
create index ai_requests_user_idx on ai_requests (user_id, created_at desc);

create table ai_usage (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references users (id) on delete cascade,
  period         date not null,
  provider       text not null,
  request_count  integer not null default 0,
  input_tokens   bigint not null default 0,
  output_tokens  bigint not null default 0,
  unique (user_id, period, provider)
);

create table learning_examples (
  id                   uuid primary key default gen_random_uuid(),
  source               text not null check (source in (
                         'USER_VERIFIED', 'GEMINI_USER_VERIFIED', 'LOCAL_AI_USER_VERIFIED',
                         'SUCCESSFUL_APPLICATION', 'USER_CORRECTION', 'ADMIN_VERIFIED')),
  -- traceability for data-deletion / retraining workflows; never exported to datasets
  contributor_user_id  uuid references users (id) on delete set null,
  domain               text,
  field_label          text not null,
  -- non-sensitive structural context only: section, input type, option labels. Never values.
  field_context        jsonb not null default '{}'::jsonb,
  language             text not null default 'en',
  profile_field_key    text not null,
  status               text not null default 'PENDING'
                       check (status in ('PENDING', 'APPROVED', 'REJECTED', 'REMOVED')),
  reviewed_by          uuid references users (id) on delete set null,
  reviewed_at          timestamptz,
  created_at           timestamptz not null default now()
);
create index learning_examples_status_idx on learning_examples (status, created_at);
create index learning_examples_contributor_idx on learning_examples (contributor_user_id);

create table learning_corrections (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid references users (id) on delete set null,
  application_id     uuid references applications (id) on delete set null,
  domain             text,
  form_signature_id  uuid references form_signatures (id) on delete set null,
  field_label        text not null,
  original_mapping   text,
  correct_mapping    text not null,
  original_provider  text,
  reason             text,
  created_at         timestamptz not null default now()
);

create table training_datasets (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  version        integer not null,
  status         text not null default 'DRAFT' check (status in ('DRAFT', 'VALIDATED', 'LOCKED', 'DISCARDED')),
  example_count  integer not null default 0,
  storage_key    text,
  stats          jsonb not null default '{}'::jsonb,
  created_by     uuid references users (id) on delete set null,
  created_at     timestamptz not null default now(),
  unique (name, version)
);

create table training_dataset_examples (
  dataset_id  uuid not null references training_datasets (id) on delete cascade,
  example_id  uuid not null references learning_examples (id) on delete cascade,
  split       text not null check (split in ('train', 'validation', 'test')),
  primary key (dataset_id, example_id)
);

create table model_versions (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,
  base_model    text not null,
  adapter_path  text,
  dataset_id    uuid references training_datasets (id) on delete set null,
  status        text not null default 'TRAINING' check (status in (
                  'TRAINING', 'EVALUATING', 'STAGING', 'PRODUCTION', 'RETIRED', 'FAILED', 'DISABLED')),
  metrics       jsonb not null default '{}'::jsonb,
  promoted_at   timestamptz,
  promoted_by   uuid references users (id) on delete set null,
  created_at    timestamptz not null default now()
);
create unique index model_versions_single_production on model_versions ((status))
  where status = 'PRODUCTION';

-- -----------------------------------------------------------------------------
-- Audit & notifications
-- -----------------------------------------------------------------------------
create table audit_logs (
  id               uuid primary key default gen_random_uuid(),
  actor_id         uuid references users (id) on delete set null,
  actor_role       text,
  action           text not null,
  target_type      text,
  target_id        text,
  subject_user_id  uuid references users (id) on delete set null,
  cafe_id          uuid references cafes (id) on delete set null,
  ip_address       text,
  user_agent       text,
  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);
create index audit_logs_subject_idx on audit_logs (subject_user_id, created_at desc);
create index audit_logs_actor_idx on audit_logs (actor_id, created_at desc);
create index audit_logs_created_idx on audit_logs (created_at desc);

create table notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  type        text not null,
  title       text not null,
  body        text,
  link        text,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index notifications_user_idx on notifications (user_id, created_at desc);
