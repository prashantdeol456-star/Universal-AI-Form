-- =============================================================================
-- 0002_rls.sql — Row Level Security, grants, and access helper functions
--
-- Database roles
--   * Owner role (POSTGRES_USER, e.g. ufa_owner): owns all objects, runs migrations,
--     and is used ONLY by the server-side "system" pool (auth lookups, background jobs).
--     Table owners bypass RLS (tables are NOT forced), so the system pool is trusted code.
--   * ufa_app: the runtime role for every user-scoped request. No BYPASSRLS.
--     Each request runs in a transaction that sets:
--         set_config('app.user_id',   '<uuid>', true)
--         set_config('app.user_role', '<role>', true)
--     All policies below are evaluated against those settings.
--
-- The ufa_app role itself is created by the migration runner (packages/db) before
-- migrations execute, because its password comes from the environment.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Context helpers
-- -----------------------------------------------------------------------------
create or replace function app.current_user_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create or replace function app.current_user_role() returns text
language sql stable as $$
  select nullif(current_setting('app.user_role', true), '')
$$;

create or replace function app.is_super_admin() returns boolean
language sql stable as $$
  select coalesce(app.current_user_role() = 'SUPER_ADMIN', false)
$$;

-- Maps a profile field key to the café permission that unlocks it.
-- Returns NULL for categories that a café can never read (bank).
create or replace function app.field_permission(p_field_key text) returns text
language sql immutable as $$
  select case split_part(p_field_key, '.', 1)
    when 'personal'    then 'basic_profile'
    when 'contact'     then 'contact'
    when 'family'      then 'family'
    when 'education'   then 'education'
    when 'employment'  then 'employment'
    when 'recruitment' then 'recruitment'
    when 'identity'    then 'identity'
    when 'custom'      then 'custom'
    else null  -- 'bank' and unknown categories: never exposed to cafés
  end
$$;

-- True when the current user is an operator with an ACTIVE, unexpired, unrevoked
-- café session for p_customer that includes p_permission.
-- SECURITY DEFINER so it can read cafe_sessions without recursive RLS evaluation.
create or replace function app.cafe_session_allows(p_customer uuid, p_permission text) returns boolean
language sql stable security definer set search_path = public, app as $$
  select p_permission is not null and exists (
    select 1
      from cafe_sessions s
      join cafe_permissions p on p.cafe_session_id = s.id
      join cafe_users cu on cu.cafe_id = s.cafe_id and cu.user_id = s.operator_id and cu.status = 'ACTIVE'
     where s.customer_id = p_customer
       and s.operator_id = app.current_user_id()
       and s.status = 'ACTIVE'
       and s.revoked_at is null
       and s.expires_at > now()
       and p.permission = p_permission
  )
$$;

create or replace function app.is_cafe_member(p_cafe uuid) returns boolean
language sql stable security definer set search_path = public, app as $$
  select exists (
    select 1 from cafe_users
     where cafe_id = p_cafe and user_id = app.current_user_id() and status = 'ACTIVE'
  )
$$;

create or replace function app.is_cafe_owner(p_cafe uuid) returns boolean
language sql stable security definer set search_path = public, app as $$
  select exists (
    select 1 from cafes where id = p_cafe and owner_id = app.current_user_id() and deleted_at is null
  ) or exists (
    select 1 from cafe_users
     where cafe_id = p_cafe and user_id = app.current_user_id()
       and cafe_role = 'OWNER' and status = 'ACTIVE'
  )
$$;

create or replace function app.can_see_application(p_app uuid) returns boolean
language sql stable security definer set search_path = public, app as $$
  select exists (
    select 1 from applications a
     where a.id = p_app
       and (
         a.customer_id = app.current_user_id()
         or a.operator_id = app.current_user_id()
         or (a.cafe_id is not null and app.is_cafe_owner(a.cafe_id))
         or app.is_super_admin()
       )
  )
$$;

revoke all on function app.cafe_session_allows(uuid, text) from public;
revoke all on function app.is_cafe_member(uuid) from public;
revoke all on function app.is_cafe_owner(uuid) from public;
revoke all on function app.can_see_application(uuid) from public;

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
grant usage on schema public, app to ufa_app;
grant execute on all functions in schema app to ufa_app;

-- Identity tables: the runtime role may only read itself and edit non-privileged columns.
-- password_hash, lockout counters etc. are not readable by the runtime role.
grant select (id, email, email_verified_at, full_name, mobile, role, status,
              last_login_at, created_at, updated_at, deleted_at) on users to ufa_app;
grant update (full_name, mobile) on users to ufa_app;
grant select, update (revoked_at, last_seen_at) on auth_sessions to ufa_app;
-- auth_tokens: no runtime-role access at all (system pool only).

grant select, insert, update on profiles to ufa_app;
grant select, insert, update on profile_custom_fields to ufa_app;
grant select, insert, update on profile_fields to ufa_app;
grant select, insert on profile_field_history to ufa_app;
grant select, insert, update on documents to ufa_app;
grant select, insert, update on document_extractions to ufa_app;
grant select, insert, update on document_conflicts to ufa_app;
grant select, insert, update on chat_sessions to ufa_app;
grant select, insert on chat_messages to ufa_app;
grant select, insert, update on cafes to ufa_app;
grant select, insert, update on cafe_users to ufa_app;
grant select, insert, delete on cafe_customers to ufa_app;
grant select, insert on cafe_sessions to ufa_app;
grant update (status, approved_at, expires_at, revoked_at, revoked_by) on cafe_sessions to ufa_app;
grant select, insert, delete on cafe_permissions to ufa_app;
grant select on form_signatures to ufa_app;
grant select, insert, update on form_mappings to ufa_app;
grant select, insert, update on saved_forms to ufa_app;
grant select, insert, update on applications to ufa_app;
grant select, insert on application_fields to ufa_app;
grant select, insert on application_documents to ufa_app;
grant select, insert on application_events to ufa_app;
grant select, insert, update (user_confirmed, user_corrected) on ai_requests to ufa_app;
grant select on ai_usage to ufa_app;
grant select, insert on learning_corrections to ufa_app;
grant select on learning_examples, training_datasets, training_dataset_examples, model_versions to ufa_app;
grant select, insert on audit_logs to ufa_app;   -- append-only for the runtime role
grant select, update (read_at) on notifications to ufa_app;

-- -----------------------------------------------------------------------------
-- Enable RLS on every table holding tenant or personal data
-- -----------------------------------------------------------------------------
alter table users                     enable row level security;
alter table auth_sessions             enable row level security;
alter table auth_tokens               enable row level security;
alter table profiles                  enable row level security;
alter table profile_custom_fields     enable row level security;
alter table profile_fields            enable row level security;
alter table profile_field_history     enable row level security;
alter table documents                 enable row level security;
alter table document_extractions      enable row level security;
alter table document_conflicts        enable row level security;
alter table chat_sessions             enable row level security;
alter table chat_messages             enable row level security;
alter table cafes                     enable row level security;
alter table cafe_users                enable row level security;
alter table cafe_customers            enable row level security;
alter table cafe_sessions             enable row level security;
alter table cafe_permissions          enable row level security;
alter table form_signatures           enable row level security;
alter table form_mappings             enable row level security;
alter table saved_forms               enable row level security;
alter table applications              enable row level security;
alter table application_fields        enable row level security;
alter table application_documents     enable row level security;
alter table application_events        enable row level security;
alter table ai_requests               enable row level security;
alter table ai_usage                  enable row level security;
alter table learning_examples         enable row level security;
alter table learning_corrections      enable row level security;
alter table training_datasets         enable row level security;
alter table training_dataset_examples enable row level security;
alter table model_versions            enable row level security;
alter table audit_logs                enable row level security;
alter table notifications             enable row level security;

-- -----------------------------------------------------------------------------
-- Policies
-- -----------------------------------------------------------------------------

-- users: self; super admin can list users (no password hashes are exposed by the app).
create policy users_select on users for select to ufa_app
  using (id = app.current_user_id() or app.is_super_admin());
create policy users_update_self on users for update to ufa_app
  using (id = app.current_user_id()) with check (id = app.current_user_id());

-- auth_sessions: users can see and revoke their own sessions.
create policy auth_sessions_self on auth_sessions for all to ufa_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());

-- Owner-only personal tables -------------------------------------------------
create policy profiles_owner on profiles for all to ufa_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());

create policy profile_custom_fields_owner on profile_custom_fields for all to ufa_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
create policy profile_custom_fields_cafe_read on profile_custom_fields for select to ufa_app
  using (app.cafe_session_allows(user_id, 'custom'));

create policy profile_fields_owner on profile_fields for all to ufa_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
-- Café operators: read-only, per category, only during an approved active session.
-- Super admins deliberately have NO policy here: admins cannot read profile values.
create policy profile_fields_cafe_read on profile_fields for select to ufa_app
  using (deleted_at is null and app.cafe_session_allows(user_id, app.field_permission(field_key)));

create policy profile_field_history_owner on profile_field_history for all to ufa_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());

create policy documents_owner on documents for all to ufa_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
create policy documents_cafe_read on documents for select to ufa_app
  using (deleted_at is null and app.cafe_session_allows(user_id, 'documents'));

create policy document_extractions_owner on document_extractions for all to ufa_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
create policy document_conflicts_owner on document_conflicts for all to ufa_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());

create policy chat_sessions_owner on chat_sessions for all to ufa_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
create policy chat_messages_owner on chat_messages for all to ufa_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());

create policy saved_forms_owner on saved_forms for all to ufa_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());

create policy notifications_owner on notifications for all to ufa_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());

-- Cafés ---------------------------------------------------------------------
create policy cafes_select on cafes for select to ufa_app
  using (owner_id = app.current_user_id() or app.is_cafe_member(id) or app.is_super_admin()
         or exists (select 1 from cafe_customers cc
                     where cc.cafe_id = cafes.id and cc.customer_id = app.current_user_id()));
create policy cafes_insert on cafes for insert to ufa_app
  with check (owner_id = app.current_user_id() and app.current_user_role() = 'CAFE_OWNER');
create policy cafes_update on cafes for update to ufa_app
  using (owner_id = app.current_user_id() or app.is_super_admin())
  with check (owner_id = app.current_user_id() or app.is_super_admin());

create policy cafe_users_select on cafe_users for select to ufa_app
  using (user_id = app.current_user_id() or app.is_cafe_owner(cafe_id) or app.is_super_admin());
create policy cafe_users_write on cafe_users for insert to ufa_app
  with check (app.is_cafe_owner(cafe_id));
create policy cafe_users_update on cafe_users for update to ufa_app
  using (app.is_cafe_owner(cafe_id)) with check (app.is_cafe_owner(cafe_id));

create policy cafe_customers_select on cafe_customers for select to ufa_app
  using (customer_id = app.current_user_id() or app.is_cafe_member(cafe_id) or app.is_super_admin());
create policy cafe_customers_insert on cafe_customers for insert to ufa_app
  with check (app.is_cafe_member(cafe_id));
create policy cafe_customers_delete on cafe_customers for delete to ufa_app
  using (customer_id = app.current_user_id() or app.is_cafe_owner(cafe_id));

-- Café sessions: an operator requests; only the customer can approve.
create policy cafe_sessions_select on cafe_sessions for select to ufa_app
  using (customer_id = app.current_user_id() or operator_id = app.current_user_id()
         or app.is_cafe_owner(cafe_id) or app.is_super_admin());
create policy cafe_sessions_request on cafe_sessions for insert to ufa_app
  with check (operator_id = app.current_user_id() and app.is_cafe_member(cafe_id)
              and status = 'PENDING' and approved_at is null);
create policy cafe_sessions_customer_update on cafe_sessions for update to ufa_app
  using (customer_id = app.current_user_id()) with check (customer_id = app.current_user_id());
-- Café side may only end a session early (revoke), never activate it.
create policy cafe_sessions_cafe_revoke on cafe_sessions for update to ufa_app
  using (operator_id = app.current_user_id() or app.is_cafe_owner(cafe_id))
  with check (status in ('REVOKED', 'EXPIRED'));

create policy cafe_permissions_select on cafe_permissions for select to ufa_app
  using (exists (select 1 from cafe_sessions s where s.id = cafe_session_id));
-- Permissions can only be attached while the session is still PENDING (before the
-- customer approves), and are then frozen.
create policy cafe_permissions_insert on cafe_permissions for insert to ufa_app
  with check (exists (select 1 from cafe_sessions s
                       where s.id = cafe_session_id and s.status = 'PENDING'
                         and s.operator_id = app.current_user_id()));
create policy cafe_permissions_customer_delete on cafe_permissions for delete to ufa_app
  using (exists (select 1 from cafe_sessions s
                  where s.id = cafe_session_id and s.customer_id = app.current_user_id()));

-- Forms knowledge base: shared generic knowledge is readable by any signed-in user.
create policy form_signatures_read on form_signatures for select to ufa_app
  using (app.current_user_id() is not null);
create policy form_mappings_read on form_mappings for select to ufa_app
  using ((scope in ('GLOBAL', 'WEBSITE') and app.current_user_id() is not null)
         or (scope = 'USER' and user_id = app.current_user_id())
         or app.is_super_admin());
-- Runtime role can only write USER-scoped mappings for itself; GLOBAL/WEBSITE
-- promotion is done by the learning engine through the system pool.
create policy form_mappings_user_write on form_mappings for insert to ufa_app
  with check (scope = 'USER' and user_id = app.current_user_id());
create policy form_mappings_user_update on form_mappings for update to ufa_app
  using (scope = 'USER' and user_id = app.current_user_id())
  with check (scope = 'USER' and user_id = app.current_user_id());

-- Applications ---------------------------------------------------------------
create policy applications_select on applications for select to ufa_app
  using (customer_id = app.current_user_id() or operator_id = app.current_user_id()
         or (cafe_id is not null and app.is_cafe_owner(cafe_id)) or app.is_super_admin());
create policy applications_insert on applications for insert to ufa_app
  with check (
    (customer_id = app.current_user_id() and operator_id is null and cafe_id is null)
    or (operator_id = app.current_user_id() and cafe_session_id is not null
        and app.cafe_session_allows(customer_id, 'applications'))
  );
create policy applications_update on applications for update to ufa_app
  using (customer_id = app.current_user_id() or operator_id = app.current_user_id())
  with check (customer_id = app.current_user_id() or operator_id = app.current_user_id());

create policy application_fields_select on application_fields for select to ufa_app
  using (app.can_see_application(application_id));
create policy application_fields_insert on application_fields for insert to ufa_app
  with check (app.can_see_application(application_id));
create policy application_documents_select on application_documents for select to ufa_app
  using (app.can_see_application(application_id));
create policy application_documents_insert on application_documents for insert to ufa_app
  with check (app.can_see_application(application_id));
create policy application_events_select on application_events for select to ufa_app
  using (app.can_see_application(application_id));
create policy application_events_insert on application_events for insert to ufa_app
  with check (app.can_see_application(application_id) and actor_id = app.current_user_id());

-- AI telemetry ---------------------------------------------------------------
create policy ai_requests_select on ai_requests for select to ufa_app
  using (user_id = app.current_user_id() or app.is_super_admin());
create policy ai_requests_insert on ai_requests for insert to ufa_app
  with check (user_id = app.current_user_id());
create policy ai_requests_update on ai_requests for update to ufa_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
create policy ai_usage_select on ai_usage for select to ufa_app
  using (user_id = app.current_user_id() or app.is_super_admin());

-- Learning: corrections are written by users about their own work; everything
-- else is admin-only (managed via the system pool by admin endpoints).
create policy learning_corrections_insert on learning_corrections for insert to ufa_app
  with check (user_id = app.current_user_id());
create policy learning_corrections_select on learning_corrections for select to ufa_app
  using (user_id = app.current_user_id() or app.is_super_admin());
create policy learning_examples_admin on learning_examples for select to ufa_app
  using (app.is_super_admin() or contributor_user_id = app.current_user_id());
create policy training_datasets_admin on training_datasets for select to ufa_app
  using (app.is_super_admin());
create policy training_dataset_examples_admin on training_dataset_examples for select to ufa_app
  using (app.is_super_admin());
create policy model_versions_admin on model_versions for select to ufa_app
  using (app.is_super_admin());

-- Audit: append-only. Users can see events about themselves or by themselves.
create policy audit_logs_insert on audit_logs for insert to ufa_app
  with check (actor_id = app.current_user_id());
create policy audit_logs_select on audit_logs for select to ufa_app
  using (subject_user_id = app.current_user_id() or actor_id = app.current_user_id()
         or app.is_super_admin());
