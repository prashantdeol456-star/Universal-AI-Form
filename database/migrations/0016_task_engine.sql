-- AI browser Phase 1: persistent task engine.
--
-- tasks        one long-running job of a user (state machine in packages/shared/src/tasks.ts)
-- task_steps   ordered steps of a task; server steps run in the web process, browser steps
--              are claimed by the user's extension (later phase), approval steps wait for the user
-- task_events  append-only history shown to the user (no secrets, no message/profile content)
-- approvals    a user's decision on one gated action of one step; final once decided, usable once
--
-- Ownership: every row carries user_id; steps, events and approvals reference (task_id, user_id)
-- so a row can never point at another user's task. RLS: owner only for the runtime role. The
-- task runner uses the owner pool, like the document worker.

create table tasks (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users (id) on delete cascade,
  title               text not null check (char_length(title) between 1 and 200),
  description         text check (char_length(description) <= 2000),
  task_type           text not null check (task_type ~ '^[a-z][a-z0-9_]{1,40}$'),
  status              text not null default 'queued'
                      check (status in ('queued', 'running', 'waiting_for_browser', 'waiting_for_approval', 'paused', 'completed', 'failed', 'cancelled')),
  priority            smallint not null default 0 check (priority between -10 and 10),
  input_json          jsonb not null default '{}'::jsonb,
  result_json         jsonb,
  checkpoint_json     jsonb,
  error_code          text,
  error_message       text check (char_length(error_message) <= 500),
  -- Duplicate-request protection: the same key from the same user returns the existing task.
  idempotency_key     text check (char_length(idempotency_key) between 8 and 100),
  -- Worker lease: who runs the task now and until when. The token is random and never shown.
  lease_owner         text,
  lease_token         uuid,
  lease_expires_at    timestamptz,
  attempt_count       integer not null default 0 check (attempt_count >= 0),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  started_at          timestamptz,
  completed_at        timestamptz,
  cancelled_at        timestamptz,
  last_checkpoint_at  timestamptz,
  unique (id, user_id)
);
create unique index tasks_idempotency on tasks (user_id, idempotency_key) where idempotency_key is not null;
create index tasks_user_status_idx on tasks (user_id, status, created_at desc);
create index tasks_claimable_idx on tasks (priority desc, created_at) where status in ('queued', 'running', 'waiting_for_browser');
create trigger tasks_updated_at before update on tasks for each row execute function app.set_updated_at();

create table task_steps (
  id               uuid primary key default gen_random_uuid(),
  task_id          uuid not null,
  user_id          uuid not null,
  step_key         text not null check (step_key ~ '^[a-z0-9_.-]{1,60}$'),
  step_type        text not null check (step_type ~ '^(server|browser|approval)\.[a-z0-9_]{1,60}$'),
  title            text not null check (char_length(title) between 1 and 200),
  status           text not null default 'pending'
                   check (status in ('pending', 'running', 'waiting', 'completed', 'failed', 'skipped', 'cancelled')),
  -- Whether running the step twice is harmless (decides lease-expiry recovery).
  idempotent       boolean not null default true,
  input_json       jsonb not null default '{}'::jsonb,
  result_json      jsonb,
  -- Step output that contains personal text (drafts, answers): AES-GCM ciphertext from the app.
  result_secret    text,
  error_code       text,
  error_message    text check (char_length(error_message) <= 500),
  sequence_number  integer not null check (sequence_number >= 0),
  attempt_count    integer not null default 0 check (attempt_count >= 0),
  started_at       timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (task_id, user_id) references tasks (id, user_id) on delete cascade,
  unique (task_id, sequence_number),
  unique (task_id, step_key)
);
create index task_steps_task_idx on task_steps (task_id, sequence_number);
create trigger task_steps_updated_at before update on task_steps for each row execute function app.set_updated_at();

create table task_events (
  id             bigint generated always as identity primary key,
  task_id        uuid not null,
  user_id        uuid not null,
  step_id        uuid references task_steps (id) on delete cascade,
  event_type     text not null check (event_type ~ '^[a-z][a-z0-9_.]{1,60}$'),
  message        text not null check (char_length(message) between 1 and 500),
  metadata_json  jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  foreign key (task_id, user_id) references tasks (id, user_id) on delete cascade
);
create index task_events_task_idx on task_events (task_id, id desc);

create table approvals (
  id                      uuid primary key default gen_random_uuid(),
  task_id                 uuid not null,
  user_id                 uuid not null,
  step_id                 uuid not null references task_steps (id) on delete cascade,
  action_type             text not null check (action_type ~ '^[a-z][a-z0-9_.]{1,60}$'),
  action_summary          text not null check (char_length(action_summary) between 1 and 300),
  status                  text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired')),
  -- What exactly is being approved: a hash binds the approval to this one action's payload.
  requested_payload_json  jsonb not null default '{}'::jsonb,
  payload_hash            text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  decision_payload_json   jsonb,
  created_at              timestamptz not null default now(),
  decided_at              timestamptz,
  expires_at              timestamptz not null,
  -- Set when the approved action is carried out; an approval is usable once.
  consumed_at             timestamptz,
  foreign key (task_id, user_id) references tasks (id, user_id) on delete cascade,
  check ((status = 'pending') = (decided_at is null) or status = 'expired'),
  check (consumed_at is null or status = 'approved')
);
-- At most one open approval per step.
create unique index approvals_one_pending on approvals (step_id) where status = 'pending';
create index approvals_user_idx on approvals (user_id, status, created_at desc);

-- A decision is final: once not pending, status and payload never change; consumption happens once.
create or replace function app.approvals_guard() returns trigger language plpgsql as $$
begin
  if old.status <> 'pending' and new.status <> old.status then
    raise exception 'approval % is already %', old.id, old.status using errcode = 'check_violation';
  end if;
  if new.requested_payload_json is distinct from old.requested_payload_json or new.payload_hash <> old.payload_hash
     or new.action_type <> old.action_type or new.step_id <> old.step_id or new.task_id <> old.task_id or new.user_id <> old.user_id then
    raise exception 'approval % cannot be re-targeted', old.id using errcode = 'check_violation';
  end if;
  if old.consumed_at is not null and new.consumed_at is distinct from old.consumed_at then
    raise exception 'approval % was already used', old.id using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger approvals_guard before update on approvals for each row execute function app.approvals_guard();

-- Events are history: never edited or removed by the runtime role.
alter table tasks enable row level security;
alter table tasks force row level security;
alter table task_steps enable row level security;
alter table task_steps force row level security;
alter table task_events enable row level security;
alter table task_events force row level security;
alter table approvals enable row level security;
alter table approvals force row level security;

grant select, insert, update on tasks to ufa_app;
grant select, insert, update on task_steps to ufa_app;
grant select, insert on task_events to ufa_app;
grant usage on sequence task_events_id_seq to ufa_app;
grant select on approvals to ufa_app;
grant update (status, decision_payload_json, decided_at, consumed_at) on approvals to ufa_app;

create policy tasks_own on tasks for all to ufa_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
create policy task_steps_own on task_steps for all to ufa_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
create policy task_events_own on task_events for all to ufa_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
create policy approvals_own on approvals for all to ufa_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
