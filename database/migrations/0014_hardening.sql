-- Phase 13: hardening.

-- Account deletion: requested by the user, permanent after a grace period (they
-- can cancel until then). The purge job deletes rows and files.
alter table users
  add column if not exists deletion_requested_at timestamptz,
  add column if not exists deletion_scheduled_for timestamptz;
create index if not exists users_deletion_due_idx on users (deletion_scheduled_for) where deletion_scheduled_for is not null;

-- Two-step verification (TOTP). The secret is stored encrypted, recovery codes as
-- hashes. None of these columns is granted to the runtime role (users has a
-- column-level select grant), so only the server's system pool can read them.
alter table users
  add column if not exists mfa_totp_secret text,
  add column if not exists mfa_enabled_at timestamptz,
  add column if not exists mfa_recovery_hashes text[] not null default '{}';

-- Short-lived token between "password correct" and "second factor correct".
alter table auth_tokens drop constraint if exists auth_tokens_purpose_check;
alter table auth_tokens add constraint auth_tokens_purpose_check
  check (purpose in ('EMAIL_VERIFY', 'PASSWORD_RESET', 'LOGIN_OTP', 'MFA_PENDING'));

-- Unread notifications (header bell).
create index if not exists notifications_unread_idx on notifications (user_id) where read_at is null;

-- Runaway queries and abandoned transactions cannot hold the runtime pool hostage.
do $$
begin
  execute 'alter role ufa_app set statement_timeout = ''15s''';
  execute 'alter role ufa_app set idle_in_transaction_session_timeout = ''30s''';
exception when others then
  raise notice 'could not set ufa_app timeouts (%), set them manually', sqlerrm;
end;
$$;
