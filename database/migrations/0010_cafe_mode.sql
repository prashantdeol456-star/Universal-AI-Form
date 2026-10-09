-- Phase 10: cyber café mode.
--
-- 0001/0002 already model cafés, operators, customer-approved time-boxed sessions
-- and per-category permissions (bank never grantable). This migration closes the
-- remaining gaps before the feature goes live.

-- 1. Session lifecycle is a one-way state machine, enforced for every role (incl. the system pool):
--      PENDING → ACTIVE | REJECTED | REVOKED | EXPIRED      ACTIVE → REVOKED | EXPIRED      (others are final)
--    An approved session lasts at most 12 hours and can only be shortened afterwards.
create or replace function app.guard_cafe_session() returns trigger
language plpgsql as $$
declare
  max_len constant interval := interval '12 hours';
begin
  if tg_op = 'INSERT' then
    if new.status not in ('PENDING', 'ACTIVE') then
      raise exception 'a café session starts as PENDING (or ACTIVE via a customer code)' using errcode = 'P0001';
    end if;
    if new.status = 'ACTIVE' and (new.approved_at is null or new.expires_at > now() + max_len or new.expires_at <= now()) then
      raise exception 'an active café session needs an approval time and must end within 12 hours' using errcode = 'P0001';
    end if;
    if new.status = 'PENDING' and new.expires_at > now() + max_len then
      raise exception 'a café request may stay open at most 12 hours' using errcode = 'P0001';
    end if;
    return new;
  end if;

  if new.cafe_id <> old.cafe_id or new.customer_id <> old.customer_id or new.operator_id <> old.operator_id then
    raise exception 'café session parties cannot change' using errcode = 'P0001';
  end if;

  if new.status is distinct from old.status then
    if not (
         (old.status = 'PENDING' and new.status in ('ACTIVE', 'REJECTED', 'REVOKED', 'EXPIRED'))
      or (old.status = 'ACTIVE' and new.status in ('REVOKED', 'EXPIRED'))
    ) then
      raise exception 'invalid café session change: % -> %', old.status, new.status using errcode = 'P0001';
    end if;
    if new.status = 'ACTIVE' then
      if new.approved_at is null or new.expires_at <= now() or new.expires_at > now() + max_len then
        raise exception 'approval needs an end time within the next 12 hours' using errcode = 'P0001';
      end if;
    end if;
    if new.status = 'REVOKED' and new.revoked_at is null then
      new.revoked_at := now();
    end if;
  elsif old.status = 'ACTIVE' and new.expires_at > old.expires_at then
    raise exception 'an active café session can be shortened, never extended' using errcode = 'P0001';
  end if;

  if old.approved_at is not null and new.approved_at is distinct from old.approved_at then
    raise exception 'approval time cannot change' using errcode = 'P0001';
  end if;
  if old.status in ('REVOKED', 'EXPIRED', 'REJECTED') and (new.expires_at <> old.expires_at or new.revoked_at is distinct from old.revoked_at) then
    raise exception 'a closed café session is final' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger cafe_sessions_guard
  before insert or update on cafe_sessions
  for each row execute function app.guard_cafe_session();

create index if not exists cafe_sessions_active_idx on cafe_sessions (expires_at) where status = 'ACTIVE';

-- 2. Filled values are the customer's. A café sees an application's values only while
--    the session that allows it is active; afterwards only metadata (form, status, dates).
create or replace function app.can_see_application_values(p_app uuid) returns boolean
language sql stable security definer set search_path = public, app as $$
  select exists (
    select 1 from applications a
     where a.id = p_app
       and (
         a.customer_id = app.current_user_id()
         or (a.operator_id = app.current_user_id() and app.cafe_session_allows(a.customer_id, 'applications'))
       )
  )
$$;
revoke all on function app.can_see_application_values(uuid) from public;
grant execute on function app.can_see_application_values(uuid) to ufa_app;

drop policy if exists application_fields_select on application_fields;
create policy application_fields_select on application_fields for select to ufa_app
  using (app.can_see_application_values(application_id));

-- 3. Customer access codes: the customer chooses what to share and for how long,
--    then reads an 8-character code to the operator. Only a hash is stored; the code
--    works once, for 15 minutes. Redemption happens on the server (system pool).
create table if not exists cafe_access_codes (
  id                uuid primary key default gen_random_uuid(),
  customer_id       uuid not null references users (id) on delete cascade,
  code_hash         text not null unique,
  permissions       text[] not null check (
                      cardinality(permissions) between 1 and 10 and
                      permissions <@ array['basic_profile', 'contact', 'family', 'education', 'employment',
                                           'recruitment', 'identity', 'documents', 'applications', 'custom']::text[]),
  duration_minutes  integer not null check (duration_minutes between 15 and 720),
  purpose           text check (char_length(purpose) <= 200),
  expires_at        timestamptz not null,
  used_at           timestamptz,
  used_session_id   uuid references cafe_sessions (id) on delete set null,
  cancelled_at      timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists cafe_access_codes_customer_idx on cafe_access_codes (customer_id, created_at desc);

alter table cafe_access_codes enable row level security;
grant select, insert on cafe_access_codes to ufa_app;
grant update (cancelled_at) on cafe_access_codes to ufa_app;
create policy cafe_access_codes_owner_select on cafe_access_codes for select to ufa_app
  using (customer_id = app.current_user_id());
create policy cafe_access_codes_owner_insert on cafe_access_codes for insert to ufa_app
  with check (customer_id = app.current_user_id() and used_at is null and cancelled_at is null
              and expires_at <= now() + interval '15 minutes');
create policy cafe_access_codes_owner_cancel on cafe_access_codes for update to ufa_app
  using (customer_id = app.current_user_id()) with check (customer_id = app.current_user_id());
