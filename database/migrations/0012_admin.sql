-- Phase 12: admin dashboard.
--
-- Admin screens aggregate across tenants on the server (system pool, permission-
-- checked and audited). They never read profile values, filled values, OCR text
-- or chat — see apps/web/src/server/admin and its privacy test.

-- A suspended or closed café loses customer access immediately, at the database level
-- (until now only the API refused it).
create or replace function app.cafe_session_allows(p_customer uuid, p_permission text) returns boolean
language sql stable security definer set search_path = public, app as $$
  select p_permission is not null and exists (
    select 1
      from cafe_sessions s
      join cafe_permissions p on p.cafe_session_id = s.id
      join cafe_users cu on cu.cafe_id = s.cafe_id and cu.user_id = s.operator_id and cu.status = 'ACTIVE'
      join cafes c on c.id = s.cafe_id and c.status = 'ACTIVE' and c.deleted_at is null
     where s.customer_id = p_customer
       and s.operator_id = app.current_user_id()
       and s.status = 'ACTIVE'
       and s.revoked_at is null
       and s.expires_at > now()
       and p.permission = p_permission
  )
$$;
revoke all on function app.cafe_session_allows(uuid, text) from public;
grant execute on function app.cafe_session_allows(uuid, text) to ufa_app;

-- Admin lists and filters.
create index if not exists users_created_idx on users (created_at desc);
create index if not exists audit_logs_created_idx on audit_logs (created_at desc);
create index if not exists audit_logs_action_idx on audit_logs (action, created_at desc);
create index if not exists learning_examples_review_idx on learning_examples (status, normalized_label, profile_field_key);

-- Who reviewed a learning example, and why it was rejected (no values involved).
alter table learning_examples add column if not exists review_note text check (char_length(review_note) <= 300);
