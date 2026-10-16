-- AI browser Phase 3: personal knowledge base (document chunks + keyword search index).
--
-- Each processed document is split into chunks. The chunk text and its section heading are
-- AES-256-GCM encrypted by the app (like documents.extracted_text). Search uses a "blind"
-- keyword index: `terms` holds keyed HMACs of the chunk's normalised words (key derived from
-- DATA_ENCRYPTION_KEYS, per user), so PostgreSQL can find candidate chunks without ever
-- holding the words in plain text. The app decrypts only the candidates and ranks them.
--
-- Cloud AI never sees a document's text unless the user allows it for that document
-- (documents.cloud_ai_allowed, off by default).

alter table documents
  add column cloud_ai_allowed boolean not null default false,
  add column page_count integer check (page_count is null or page_count >= 0),
  add column chunk_count integer not null default 0 check (chunk_count >= 0),
  add column text_truncated boolean not null default false;

-- Users may toggle cloud AI per document (besides title and soft delete).
grant update (cloud_ai_allowed) on documents to ufa_app;

create table document_chunks (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users (id) on delete cascade,
  document_id        uuid not null references documents (id) on delete cascade,
  chunk_index        integer not null check (chunk_index >= 0),
  page_number        integer check (page_number is null or page_number > 0),
  section_encrypted  text check (section_encrypted is null or section_encrypted like 'enc:%'),
  content_encrypted  text not null check (content_encrypted like 'enc:%'),
  char_count         integer not null check (char_count > 0),
  token_count        integer not null check (token_count >= 0),
  index_key_id       text not null check (index_key_id ~ '^[a-zA-Z0-9_-]{1,16}$'),
  terms              text[] not null check (cardinality(terms) <= 400),
  created_at         timestamptz not null default now(),
  unique (document_id, chunk_index)
);
create index document_chunks_terms_idx on document_chunks using gin (terms);
create index document_chunks_user_doc_idx on document_chunks (user_id, document_id);

-- Chunks belong to the document's owner.
create or replace function app.chunk_matches_document() returns trigger
language plpgsql set search_path = public, app as $$
begin
  if not exists (select 1 from documents d where d.id = new.document_id and d.user_id = new.user_id) then
    raise exception 'chunk owner must match the document owner';
  end if;
  return new;
end $$;
create trigger document_chunks_owner before insert or update on document_chunks
  for each row execute function app.chunk_matches_document();

alter table document_chunks enable row level security;
alter table document_chunks force row level security;
-- Read-only for the runtime role: chunks are written by the document worker (system pool)
-- and removed with their document.
grant select on document_chunks to ufa_app;
create policy document_chunks_own on document_chunks for select to ufa_app
  using (user_id = app.current_user_id());

-- Deleting a document removes what was derived from it: the decrypted-text copy, the
-- chunks, and extractions the user never confirmed. Values the user confirmed into the
-- profile stay (they are the user's profile now) with their history row.
create or replace function app.purge_document_derivatives() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    delete from document_chunks where document_id = new.id;
    delete from document_extractions where document_id = new.id and status in ('PENDING', 'REJECTED');
    new.extracted_text := null;
    new.chunk_count := 0;
  end if;
  return new;
end $$;
create trigger documents_purge_derivatives before update of deleted_at on documents
  for each row execute function app.purge_document_derivatives();
