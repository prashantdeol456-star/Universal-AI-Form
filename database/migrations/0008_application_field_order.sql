-- Phase 8: keep the snapshot in page order (all rows of one confirmation share created_at).
alter table application_fields add column if not exists position integer;
