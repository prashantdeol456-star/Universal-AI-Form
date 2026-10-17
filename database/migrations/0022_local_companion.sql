-- AI browser Phase 6: local companion (paired computers), approved local actions, workflow
-- memory and task feedback.
--
-- A companion is a small program on the user's computer that connects OUT to this server
-- (no listening port on the computer). Pairing: the companion starts a pairing and shows a
-- short code; the signed-in user enters the code in the dashboard; the companion then
-- receives a device token once. Only hashes of the code, poll secret and token are stored.
--
-- A device starts with NO capabilities. Folders are granted only on the computer itself
-- (companion CLI); the server keeps a display copy and can revoke but never add. Revoking a
-- device or pressing the emergency stop blocks every further local step.

-- Local steps run on the companion, like browser steps run in the extension.
alter table task_steps drop constraint task_steps_step_type_check;
alter table task_steps add constraint task_steps_step_type_check check (step_type ~ '^(server|browser|local|approval)\.[a-z0-9_]{1,60}$');

create table companion_pairings (
  id                 uuid primary key default gen_random_uuid(),
  code_hash          text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  poll_secret_hash   text not null check (poll_secret_hash ~ '^[0-9a-f]{64}$'),
  device_name        text not null check (char_length(device_name) between 1 and 60),
  platform           text not null check (platform in ('windows', 'macos', 'linux')),
  companion_version  text not null check (companion_version ~ '^[0-9A-Za-z.+-]{1,30}$'),
  expires_at         timestamptz not null,
  confirmed_user_id  uuid references users (id) on delete cascade,
  confirmed_at       timestamptz,
  -- Set when the device token was handed out; a pairing is usable once.
  used_at            timestamptz,
  device_id          uuid,
  failed_attempts    integer not null default 0 check (failed_attempts >= 0),
  created_at         timestamptz not null default now(),
  check ((confirmed_user_id is null) = (confirmed_at is null)),
  check (used_at is null or confirmed_at is not null)
);
create index companion_pairings_expiry_idx on companion_pairings (expires_at);

create table companion_devices (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references users (id) on delete cascade,
  name                 text not null check (char_length(name) between 1 and 60),
  platform             text not null check (platform in ('windows', 'macos', 'linux')),
  companion_version    text not null check (companion_version ~ '^[0-9A-Za-z.+-]{1,30}$'),
  token_hash           text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  -- Granted by the user in the dashboard. Default: nothing.
  capabilities         text[] not null default '{}' check (capabilities <@ array[
                         'list_approved_folders', 'read_selected_files', 'create_file_in_approved_folder',
                         'move_selected_files', 'run_approved_command']::text[]),
  -- Short excerpts of local files may go to this server's AI (local model) only when allowed;
  -- to a cloud model only when that is allowed too. Both default off.
  ai_excerpts_allowed  boolean not null default false,
  cloud_ai_allowed     boolean not null default false,
  status               text not null default 'active' check (status in ('active', 'revoked')),
  revoked_at           timestamptz,
  -- Emergency stop: while set, the device gets no work. Cleared only by the user.
  stop_requested_at    timestamptz,
  last_seen_at         timestamptz,
  local_ai_status      text check (local_ai_status is null or local_ai_status in ('available', 'unavailable', 'unknown')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (id, user_id),
  check ((status = 'revoked') = (revoked_at is not null)),
  check (not cloud_ai_allowed or ai_excerpts_allowed)
);
create index companion_devices_user_idx on companion_devices (user_id, created_at desc);
create trigger companion_devices_updated_at before update on companion_devices for each row execute function app.set_updated_at();

create table companion_folders (
  id                      uuid not null,
  device_id               uuid not null,
  user_id                 uuid not null,
  -- Display copies reported by the companion (the real path never leaves the computer in clear).
  label_encrypted         text not null check (label_encrypted like 'enc:%'),
  display_path_encrypted  text not null check (display_path_encrypted like 'enc:%'),
  access                  text[] not null check (cardinality(access) between 1 and 3 and access <@ array['read', 'write', 'run']::text[]),
  revoked_at              timestamptz,
  reported_at             timestamptz not null default now(),
  primary key (device_id, id),
  foreign key (device_id, user_id) references companion_devices (id, user_id) on delete cascade
);
create index companion_folders_user_idx on companion_folders (user_id);

create table agent_workflows (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references users (id) on delete cascade,
  name                   text not null check (char_length(name) between 1 and 100),
  purpose                text check (purpose is null or char_length(purpose) <= 300),
  task_type              text not null check (task_type ~ '^[a-z][a-z0-9_]{1,40}$'),
  -- Task input to reuse (ids and options only, never file content or secrets).
  input_template         jsonb not null default '{}'::jsonb check (pg_column_size(input_template) <= 4000),
  required_capabilities  text[] not null default '{}',
  verification           text check (verification is null or char_length(verification) <= 300),
  -- A learned workflow is a draft until the user reviews it. Running one still needs every approval.
  status                 text not null default 'draft' check (status in ('draft', 'approved', 'disabled')),
  success_count          integer not null default 0 check (success_count >= 0),
  failure_count          integer not null default 0 check (failure_count >= 0),
  source_task_id         uuid references tasks (id) on delete set null,
  last_used_at           timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index agent_workflows_user_idx on agent_workflows (user_id, updated_at desc);
create trigger agent_workflows_updated_at before update on agent_workflows for each row execute function app.set_updated_at();

-- Remembered preferences ("next time"), saved only after the user confirms. Only known keys.
create table agent_preferences (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  key         text not null check (key in ('report_format', 'output_folder_id', 'organize_by', 'summary_length')),
  value       text not null check (char_length(value) between 1 and 100),
  source      text not null default 'user' check (source in ('user', 'feedback')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, key)
);
create trigger agent_preferences_updated_at before update on agent_preferences for each row execute function app.set_updated_at();

create table task_feedback (
  id              uuid primary key default gen_random_uuid(),
  task_id         uuid not null,
  user_id         uuid not null,
  correct         boolean not null,
  wrong_step_key  text check (wrong_step_key is null or wrong_step_key ~ '^[a-z0-9_.-]{1,60}$'),
  note_encrypted  text check (note_encrypted like 'enc:%'),
  -- one_time: only this task; future: the user asked to remember it (a preference is saved separately, after confirmation).
  scope           text not null default 'one_time' check (scope in ('one_time', 'future')),
  created_at      timestamptz not null default now(),
  foreign key (task_id, user_id) references tasks (id, user_id) on delete cascade
);
create index task_feedback_task_idx on task_feedback (task_id, created_at desc);

-- Folders belong to the device's owner; workflows point only at the owner's own task.
create or replace function app.companion_same_owner() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if tg_table_name = 'agent_workflows' and new.source_task_id is not null
     and not exists (select 1 from tasks t where t.id = new.source_task_id and t.user_id = new.user_id) then
    raise exception 'task belongs to another user';
  end if;
  return new;
end $$;
create trigger agent_workflows_owner before insert or update on agent_workflows for each row execute function app.companion_same_owner();

do $$
declare t text;
begin
  -- companion_pairings: no user until confirmed; only the server's owner pool touches it.
  alter table companion_pairings enable row level security;
  alter table companion_pairings force row level security;
  foreach t in array array['companion_devices', 'companion_folders', 'agent_workflows', 'agent_preferences', 'task_feedback'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy %I on %I for all to ufa_app using (user_id = app.current_user_id()) with check (user_id = app.current_user_id())', t || '_own', t);
  end loop;
end $$;

-- The runtime role can manage the user's devices but never set a token or re-activate a revoked one.
grant select, delete on companion_devices to ufa_app;
grant update (name, capabilities, ai_excerpts_allowed, cloud_ai_allowed, status, revoked_at, stop_requested_at) on companion_devices to ufa_app;
grant select on companion_folders to ufa_app;
grant update (revoked_at) on companion_folders to ufa_app;
grant select, insert, update, delete on agent_workflows to ufa_app;
grant select, insert, update, delete on agent_preferences to ufa_app;
grant select, insert, delete on task_feedback to ufa_app;

-- A revoked device stays revoked.
create or replace function app.companion_device_guard() returns trigger language plpgsql as $$
begin
  if old.status = 'revoked' and new.status <> 'revoked' then
    raise exception 'device % was revoked; pair it again', old.id using errcode = 'check_violation';
  end if;
  if new.token_hash <> old.token_hash then
    raise exception 'device token cannot be changed' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger companion_devices_guard before update on companion_devices for each row execute function app.companion_device_guard();
