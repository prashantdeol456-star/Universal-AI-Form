-- =============================================================================
-- 0004_chat_proposals.sql — Phase 3: AI chat assistant
--
-- A proposal is one profile fact the assistant understood from a chat message
-- ("Father's Name = Raj Kumar"). It is saved to the profile only when the user
-- accepts it. kind:
--   NEW    no value stored yet
--   UPDATE a different value is stored -> "I currently have X. Update to Y?"
--   SAME   identical value already stored -> informational, nothing to do
-- =============================================================================

create table chat_proposals (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users (id) on delete cascade,
  session_id      uuid not null references chat_sessions (id) on delete cascade,
  message_id      uuid not null references chat_messages (id) on delete cascade,   -- the user's message
  reply_id        uuid references chat_messages (id) on delete cascade,            -- the assistant reply showing it
  field_key       text not null,
  value           text not null,             -- encrypted when the field is sensitive
  is_encrypted    boolean not null default false,
  previous_value  text,                      -- what the profile held when proposed (encrypted if sensitive)
  confidence      numeric(4, 3) check (confidence between 0 and 1),
  method          text not null default 'rules' check (method in ('rules', 'local_ai')),
  kind            text not null check (kind in ('NEW', 'UPDATE', 'SAME')),
  status          text not null default 'PENDING'
                  check (status in ('PENDING', 'SAVED', 'REJECTED', 'SUPERSEDED', 'INFO')),
  resolved_at     timestamptz,
  created_at      timestamptz not null default now()
);
create index chat_proposals_session_idx on chat_proposals (session_id, created_at);
create index chat_proposals_pending_idx on chat_proposals (user_id, field_key) where status = 'PENDING';

alter table chat_proposals enable row level security;
create policy chat_proposals_owner on chat_proposals for all to ufa_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());

grant select, insert on chat_proposals to ufa_app;
grant update (status, resolved_at, reply_id) on chat_proposals to ufa_app;

-- Sessions: users rename/soft-delete their own conversations.
revoke update on chat_sessions from ufa_app;
grant update (title, deleted_at, updated_at) on chat_sessions to ufa_app;
