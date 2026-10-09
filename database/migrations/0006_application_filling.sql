-- Phase 7: filling forms from confirmed applications.
--
-- An application is created when the user confirms the preview in the side
-- panel: its field snapshot is written while IN_PROGRESS and the row then moves
-- to CONFIRMED, after which 0001's trigger makes the snapshot immutable. This
-- migration also protects the application row itself.

-- Only lifecycle columns may change after insert; where/what was applied for is fixed.
revoke update on applications from ufa_app;
grant update (status, application_number, confirmed_at, completed_at, submitted_at) on applications to ufa_app;

-- Allowed status changes. Anything before CONFIRMED is a draft; afterwards the
-- application can only be marked submitted / failed / cancelled, then archived.
create or replace function app.guard_application_update() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status and not (
       old.status in ('DRAFT', 'IN_PROGRESS', 'WAITING_FOR_USER', 'READY_FOR_REVIEW')
    or (old.status = 'CONFIRMED' and new.status in ('SUBMITTED', 'FAILED', 'CANCELLED', 'ARCHIVED'))
    or (old.status in ('SUBMITTED', 'FAILED', 'CANCELLED') and new.status = 'ARCHIVED')
  ) then
    raise exception 'invalid application status change: % -> %', old.status, new.status using errcode = 'P0001';
  end if;
  if old.confirmed_at is not null and new.confirmed_at is distinct from old.confirmed_at then
    raise exception 'confirmed_at cannot be changed' using errcode = 'P0001';
  end if;
  if old.submitted_at is not null and new.submitted_at is distinct from old.submitted_at then
    raise exception 'submitted_at cannot be changed' using errcode = 'P0001';
  end if;
  if old.status = 'ARCHIVED' and new.application_number is distinct from old.application_number then
    raise exception 'archived applications are read-only' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger applications_guard
  before update on applications
  for each row execute function app.guard_application_update();
