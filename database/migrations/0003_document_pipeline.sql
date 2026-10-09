-- =============================================================================
-- 0003_document_pipeline.sql — Phase 2: document processing, extraction review, conflicts
-- =============================================================================

-- documents: processing state, antivirus result, encrypted OCR text --------------
alter table documents
  add column scan_status text not null default 'PENDING'
    check (scan_status in ('PENDING', 'CLEAN', 'INFECTED', 'SKIPPED', 'ERROR')),
  add column processing_attempts integer not null default 0,
  add column processing_started_at timestamptz,
  add column processed_at timestamptz,
  add column processing_error text,
  -- Full OCR/PDF text, AES-256-GCM encrypted by the app (can contain Aadhaar etc.).
  add column extracted_text text,
  add column text_engine text,
  add column text_confidence numeric(4, 3),
  add column local_ai_used boolean not null default false;

-- Queue lookup for the background worker.
create index documents_queue_idx on documents (created_at)
  where status in ('UPLOADED', 'PROCESSING') and deleted_at is null;

-- extractions: how the value was found, and the review outcome ------------------
alter table document_extractions
  add column method text not null default 'rules'
    check (method in ('rules', 'local_ai', 'rules+local_ai')),
  add column conflict_id uuid references document_conflicts (id) on delete set null,
  add column final_value text,               -- value the user confirmed (maybe edited), encrypted if sensitive
  add column reviewed_by uuid references users (id) on delete set null;

create index document_extractions_field_idx on document_extractions (user_id, field_key)
  where status in ('PENDING', 'CONFIRMED', 'EDITED');

-- conflicts: at most one OPEN conflict per user and field --------------------------
alter table document_conflicts
  add column updated_at timestamptz not null default now();
create unique index document_conflicts_one_open on document_conflicts (user_id, field_key)
  where status = 'OPEN';
create trigger document_conflicts_updated_at before update on document_conflicts
  for each row execute function app.set_updated_at();

-- Runtime role: users may soft-delete their documents and review extractions,
-- but processing columns are written by the worker (system pool) only.
revoke update on documents from ufa_app;
grant update (title, deleted_at) on documents to ufa_app;
revoke update on document_extractions from ufa_app;
grant update (status, final_value, reviewed_at, reviewed_by, conflict_id) on document_extractions to ufa_app;
-- Users must not be able to invent extractions (they are produced by the worker).
revoke insert on document_extractions from ufa_app;

-- A user-inserted document always starts unprocessed and unscanned; only the
-- worker can mark it scanned/extracted. (Restrictive = AND-ed with documents_owner.)
create policy documents_insert_initial on documents as restrictive for insert to ufa_app
  with check (status = 'UPLOADED' and scan_status = 'PENDING' and extracted_text is null
              and processing_attempts = 0 and processed_at is null);
