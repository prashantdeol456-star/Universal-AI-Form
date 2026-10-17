-- AI browser Phase 8: multi-agent missions across the user's paired computers.
--
-- A mission is one request split by the Planner agent into ordered parts; each part is a normal
-- computer task (File or Command agent) on one device, with that task's own approvals. Parts in
-- the same group run in parallel (one per computer); groups run in order. The Reviewer agent
-- writes one review at the end. A mission never holds more power than its tasks: device
-- capabilities, approved folders and approvals are checked for every part.

create table agent_missions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users (id) on delete cascade,
  title              text not null check (char_length(title) between 1 and 200),
  request_encrypted  text not null check (request_encrypted like 'enc:%'),
  -- planned: shown to the user, nothing created yet; running: parts are dispatched;
  -- paused: a part failed or the user paused it (nothing new starts); the rest are final.
  status             text not null default 'planned' check (status in ('planned', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  status_reason      text check (status_reason is null or char_length(status_reason) <= 300),
  review_encrypted   text check (review_encrypted like 'enc:%'),
  review_provider    text check (review_provider is null or review_provider in ('rules', 'local', 'gemini')),
  started_at         timestamptz,
  completed_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (id, user_id)
);
create index agent_missions_user_idx on agent_missions (user_id, created_at desc);
create index agent_missions_active_idx on agent_missions (status) where status = 'running';
create trigger agent_missions_updated_at before update on agent_missions for each row execute function app.set_updated_at();

create table agent_mission_tasks (
  id           uuid primary key default gen_random_uuid(),
  mission_id   uuid not null,
  user_id      uuid not null,
  seq          smallint not null check (seq between 1 and 20),
  grp          smallint not null check (grp between 1 and 6),
  agent        text not null check (agent in ('file', 'command')),
  device_id    uuid not null,
  task_type    text not null check (task_type ~ '^local_[a-z_]{1,40}$'),
  -- Ids and options only (no file content), validated by the server when planned and again when run.
  input        jsonb not null check (pg_column_size(input) <= 4000),
  explanation  text not null check (char_length(explanation) between 1 and 400),
  task_id      uuid references tasks (id) on delete set null,
  attempts     smallint not null default 0 check (attempts between 0 and 5),
  status       text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed', 'cancelled', 'skipped')),
  error        text check (error is null or char_length(error) <= 300),
  updated_at   timestamptz not null default now(),
  unique (mission_id, seq),
  foreign key (mission_id, user_id) references agent_missions (id, user_id) on delete cascade,
  foreign key (device_id, user_id) references companion_devices (id, user_id) on delete cascade
);
create index agent_mission_tasks_task_idx on agent_mission_tasks (task_id);
create trigger agent_mission_tasks_updated_at before update on agent_mission_tasks for each row execute function app.set_updated_at();

-- A part may only point at the owner's own task.
create or replace function app.mission_task_same_owner() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if new.task_id is not null and not exists (select 1 from tasks t where t.id = new.task_id and t.user_id = new.user_id) then
    raise exception 'task belongs to another user';
  end if;
  return new;
end $$;
create trigger agent_mission_tasks_owner before insert or update on agent_mission_tasks for each row execute function app.mission_task_same_owner();

do $$
declare t text;
begin
  foreach t in array array['agent_missions', 'agent_mission_tasks'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy %I on %I for all to ufa_app using (user_id = app.current_user_id()) with check (user_id = app.current_user_id())', t || '_own', t);
  end loop;
end $$;

grant select, insert, delete on agent_missions to ufa_app;
grant update (status, status_reason, review_encrypted, review_provider, started_at, completed_at) on agent_missions to ufa_app;
grant select, insert on agent_mission_tasks to ufa_app;
-- The plan of a part (agent, device, type, input) is fixed once planned; only progress changes.
grant update (task_id, attempts, status, error) on agent_mission_tasks to ufa_app;
