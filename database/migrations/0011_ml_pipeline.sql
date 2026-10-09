-- Phase 11: ML training pipeline, model registry, optional pgvector label search.
--
-- Datasets are built from learning examples (structure only — labels, sections,
-- types, options, target keys; never values). Models are fine-tuned off the VPS,
-- registered, evaluated against the same frozen test set as production, and only
-- promoted by a person. Nothing is deployed automatically.

-- Model registry -------------------------------------------------------------
alter table model_versions
  add column if not exists serving_name text,          -- Ollama model tag to set as LOCAL_AI_MODEL after promotion
  add column if not exists notes text,
  add column if not exists retired_at timestamptz,
  add column if not exists previous_production_id uuid references model_versions (id) on delete set null;

alter table training_datasets
  add column if not exists manifest_sha256 text,
  add column if not exists source_filter jsonb not null default '{}'::jsonb;

-- Every evaluation run: a registered model, or a baseline such as "baseline:rules".
create table if not exists model_evaluations (
  id                uuid primary key default gen_random_uuid(),
  model_name        text not null,
  model_version_id  uuid references model_versions (id) on delete cascade,
  dataset_id        uuid references training_datasets (id) on delete cascade,
  split             text not null default 'test' check (split in ('validation', 'test', 'benchmark')),
  metrics           jsonb not null,
  created_at        timestamptz not null default now()
);
create index if not exists model_evaluations_dataset_idx on model_evaluations (dataset_id, created_at desc);

alter table model_evaluations enable row level security;
grant select on model_evaluations to ufa_app;
create policy model_evaluations_admin on model_evaluations for select to ufa_app using (app.is_super_admin());

-- Optional: pgvector label search --------------------------------------------
-- Embeddings of *shared, verified field labels only* (never values, never a user's
-- personal mappings). Created only where the server has the pgvector extension
-- (the production image pgvector/pgvector:pg16 does; a plain local PostgreSQL may
-- not — then semantic search stays in-process). Run `npm run ml -- vector-setup`
-- after installing pgvector later.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'vector') then
    execute 'create extension if not exists vector';
    execute $ddl$
      create table if not exists label_embeddings (
        id                 uuid primary key default gen_random_uuid(),
        normalized_label   text not null,
        profile_field_key  text not null,
        source             text not null,            -- catalog | global | website
        model              text not null,            -- embedding model name
        embedding          vector(768) not null,
        created_at         timestamptz not null default now(),
        unique (normalized_label, profile_field_key, model)
      )$ddl$;
    execute 'create index if not exists label_embeddings_hnsw on label_embeddings using hnsw (embedding vector_cosine_ops)';
    execute 'alter table label_embeddings enable row level security';
  end if;
end;
$$;
