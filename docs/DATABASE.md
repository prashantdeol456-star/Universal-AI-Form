# Database

PostgreSQL 16. Migrations live in `database/migrations/NNNN_name.sql` and are applied by `npm run db:migrate`
(`packages/db/src/cli.ts`). The runner records a SHA-256 checksum per file and **refuses to run if an applied migration was
edited** — always add a new migration instead.

## Roles

| Role | Used by | RLS |
|---|---|---|
| owner (`ufa_owner`, `POSTGRES_USER`) | migrations, auth lookups, background/admin jobs (`db().system`) | Bypassed (table owner) — trusted server code only |
| `ufa_app` | every user-scoped request (`asUser()` / `withUser()`) | **Enforced**. `NOSUPERUSER NOBYPASSRLS`, column-level grants |

`ufa_app` is created by the migration runner with `DB_APP_PASSWORD`. Per request: `set_config('app.user_id', …, true)` and
`set_config('app.user_role', …, true)` (transaction-local), read by `app.current_user_id()` / `app.current_user_role()`.

## Tables (0001_initial_schema.sql)

| Area | Tables |
|---|---|
| Identity | `users`, `auth_sessions`, `auth_tokens` |
| Profile | `profiles`, `profile_fields`, `profile_field_history`, `profile_custom_fields` |
| Documents | `documents`, `document_extractions`, `document_conflicts` |
| Chat | `chat_sessions`, `chat_messages` |
| Café | `cafes`, `cafe_users`, `cafe_customers`, `cafe_sessions`, `cafe_permissions` |
| Forms KB | `form_signatures`, `form_mappings`, `saved_forms` |
| Applications | `applications`, `application_fields`, `application_documents`, `application_events` |
| AI & learning | `ai_requests`, `ai_usage`, `learning_examples`, `learning_corrections`, `training_datasets`, `training_dataset_examples`, `model_versions` |
| Ops | `audit_logs`, `notifications`, `schema_migrations` |

### Profile values and provenance

`profile_fields` holds one live row per `(user_id, field_key)` (partial unique index on `deleted_at is null`) with
`value, is_encrypted, source, verified, confidence, source_document_id, source_chat_message_id, updated_by, created_at,
updated_at, last_verified_at`. Field keys are `category.name` (e.g. `family.father_name`,
`education.class_10.percentage`) defined in `packages/shared/src/profile/catalog.ts`; user-defined keys are `custom.*`.
Every change appends to `profile_field_history` (old values stay encrypted if they were).

### Immutability

`application_fields` rows cannot be inserted, updated or deleted once the parent application is `CONFIRMED`, `SUBMITTED` or
`ARCHIVED` (trigger `app.prevent_snapshot_mutation`). Only an explicit system data-deletion job may remove them by setting
`app.allow_snapshot_delete = on`.

## Document pipeline (0003_document_pipeline.sql)

- `documents`: `scan_status`, `processing_attempts`, `processing_started_at`, `processed_at`, `processing_error`, `extracted_text` (encrypted OCR text), `text_engine`, `text_confidence`, `local_ai_used`; queue index on `UPLOADED/PROCESSING`.
- `document_extractions`: `method` (`rules`, `local_ai`, `rules+local_ai`), `conflict_id`, `final_value`, `reviewed_by`.
- `document_conflicts`: unique index → **at most one OPEN conflict per user and field**.
- Runtime role may only update `documents.title/deleted_at` and the review columns of extractions; it cannot insert extractions; a restrictive policy forces new documents to start `UPLOADED` + `PENDING` scan.

## Chat (0004_chat_proposals.sql)

`chat_proposals`: one understood fact per row — `field_key`, `value` (encrypted if sensitive), `previous_value`, `kind`
(`NEW` / `UPDATE` / `SAME`), `status` (`PENDING`, `SAVED`, `REJECTED`, `SUPERSEDED`, `INFO`), `method` (`rules`/`local_ai`),
links to the user message and assistant reply. Owner-only RLS; the runtime role may only change `status`/`resolved_at`.
Chat messages are append-only for the runtime role.

## Applications (0006_application_filling.sql)

An application is created when the user confirms the preview: fields are inserted while `IN_PROGRESS`, then the row moves
to `CONFIRMED` and the 0001 trigger makes `application_fields` immutable. Values are always stored encrypted
(`is_encrypted = true`). 0006 limits the runtime role to updating `status`, `application_number`, `confirmed_at`,
`completed_at`, `submitted_at`, and a trigger allows only `draft → CONFIRMED → SUBMITTED / FAILED / CANCELLED → ARCHIVED`
(`confirmed_at` / `submitted_at` can never be rewritten). `application_events`: `CONFIRMED`, `FILLED` (counts + per-field
status/reason, no values), `UNDONE`, `SUBMITTED`, `CANCELLED`, `UPDATED`.

## History & saved forms (0007, 0008)

- `application_documents`: insert only when both the application **and the document** belong to the current user (an FK alone
  would accept a guessed document id); owners may delete links. Links are not part of the immutable value snapshot.
- `saved_forms`: one live row per (user, url) (partial unique index), `last_used_at` (set when you fill that URL), runtime
  role may update only `name`, `notes`, `deleted_at`, `last_used_at`, `form_signature_id`.
- `application_fields.position` keeps the snapshot in page order.

## Learning (0009_learning.sql)

- `form_signatures.field_signatures text[]`: every field signature (visible + hidden) seen for that page version.
- `application_fields.field_ref / field_signature / section / language`: structure of confirmed fields, so fills can teach.
- `profiles.learning_contribution_enabled` (default true).
- `form_mappings`: users may delete their own `USER` rows; `WEBSITE` / `GLOBAL` rows are written only by the system job.
- `learning_examples.field_signature / normalized_label` (+ dedupe index); `learning_runs` (system-only run log).

## Café mode (0010_cafe_mode.sql)

- `cafe_sessions` trigger `app.guard_cafe_session`: one-way lifecycle, fixed parties, approval ≤ 12 h ahead, active
  sessions may only be shortened, closed sessions are final.
- `application_fields` select policy now uses `app.can_see_application_values`: the customer, or the operator only
  while `cafe_session_allows(customer, 'applications')`. Café owners and closed sessions see no values.
- `cafe_access_codes`: customer-owned, HMAC of the code, permissions subset (never bank), 15–720 minutes, 15-minute
  validity; runtime role may only insert/see/cancel its own; redemption is server-side.

## ML pipeline (0011_ml_pipeline.sql)

- `model_versions`: `serving_name` (Ollama tag), `notes`, `retired_at`, `previous_production_id` (rollback); still one `PRODUCTION` row max.
- `training_datasets`: `manifest_sha256`, `source_filter`. `model_evaluations`: metrics per model/baseline × dataset × split (admins only).
- `label_embeddings` (only where pgvector exists): `vector(768)` + HNSW cosine index; shared verified labels only; system-only.

## Admin (0012, 0013)

- `app.cafe_session_allows` now also requires the café to be `ACTIVE` (suspending a café cuts access in the database).
- Indexes for admin lists; `learning_examples.review_note`.
- 0013 converts audit metadata that was stored as a JSON string into JSON objects (`server/audit.ts` now uses `sql.json`).

**The database must be UTF-8** (Hindi text). The migration runner refuses to run otherwise; the Docker image is UTF-8 by default.

## RLS summary (0002_rls.sql)

| Data | Who can read | Who can write |
|---|---|---|
| Own profile, documents, chat, conflicts, saved forms, notifications | Owner | Owner |
| Another customer's profile fields | Café operator **only** with an ACTIVE, unexpired, unrevoked session that includes that category's permission | Nobody |
| `bank.*` fields | Owner only — not mappable to any café permission | Owner |
| Profile values | **Not** super admins (no policy grants it) | — |
| `users.password_hash`, `auth_tokens` | Nobody via `ufa_app` (column / table grants) | System pool only |
| `users.role`, `users.status` | — | System pool only |
| Café sessions | Customer, operator, café owner | Operator inserts `PENDING`; only the customer can activate; café side can only revoke/expire |
| Café permissions | Session participants | Added only while `PENDING`, then frozen |
| Applications | Customer, operator, café owner, super admin | Customer, or operator with an `applications` permission |
| `form_mappings` GLOBAL/WEBSITE | Any signed-in user | System pool (learning engine) |
| `audit_logs` | Subject, actor, super admin | Append-only; `actor_id` must be the caller |

These guarantees are verified by `database/tests/rls.test.ts` against a real PostgreSQL.
