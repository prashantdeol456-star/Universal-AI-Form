-- AI browser Phase 2: per-site authorisation for browser actions.
--
-- A user allows one origin (scheme + host + port) for a set of scopes. The extension asks
-- Chrome for that origin only, and the server refuses form mapping, filling values and
-- document attachment for origins the user has not allowed. Submitting, payments,
-- messages and similar actions are not scopes: they can never be granted.

create table site_permissions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  origin      text not null check (
                origin ~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?$'
                or origin ~ '^http://(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+\.(localhost|test))(:[0-9]{1,5})?$'
              ),
  scopes      text[] not null check (
                cardinality(scopes) between 1 and 4
                and scopes <@ array['inspect', 'fill', 'attach_file', 'insert_text']::text[]
              ),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  revoked_at  timestamptz
);
create unique index site_permissions_active on site_permissions (user_id, origin) where revoked_at is null;
create trigger site_permissions_updated_at before update on site_permissions for each row execute function app.set_updated_at();

alter table site_permissions enable row level security;
alter table site_permissions force row level security;
grant select, insert, update on site_permissions to ufa_app;
create policy site_permissions_own on site_permissions for all to ufa_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
