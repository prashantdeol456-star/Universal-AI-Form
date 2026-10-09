-- Audit metadata written before the fix in server/audit.ts was stored as a JSON string
-- (double-encoded). Convert those rows to proper JSON objects; nothing else changes.
update audit_logs set metadata = (metadata #>> '{}')::jsonb
 where jsonb_typeof(metadata) = 'string' and left(metadata #>> '{}', 1) = '{';
