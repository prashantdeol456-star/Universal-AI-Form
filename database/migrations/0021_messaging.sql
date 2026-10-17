-- AI browser Phase 5: email (Gmail OAuth) and WhatsApp (chat exports) intelligence.
--
-- Everything is per user (forced RLS). Tokens and all message-derived text are AES-256-GCM
-- encrypted by the app ("enc:" values). Gmail message bodies are NOT stored: they are read
-- from Gmail on request; only summaries the user asked for (deletable) and drafts are kept.
-- WhatsApp content exists only from exports the user uploads, with an expiry date.
-- Nothing in this schema can send a message: drafts are created in Gmail only after the
-- user's approval, and WhatsApp drafts are copied by the user.

create table oauth_states (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references users (id) on delete cascade,
  provider                text not null check (provider in ('gmail')),
  state_hash              text not null unique check (state_hash ~ '^[0-9a-f]{64}$'),
  code_verifier_encrypted text not null check (code_verifier_encrypted like 'enc:%'),
  access                  text not null check (access in ('read', 'read_draft')),
  expires_at              timestamptz not null,
  used_at                 timestamptz,
  created_at              timestamptz not null default now()
);
create index oauth_states_user_idx on oauth_states (user_id, created_at desc);

create table mail_connections (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references users (id) on delete cascade,
  provider                 text not null check (provider in ('gmail')),
  account_email_encrypted  text not null check (account_email_encrypted like 'enc:%'),
  scopes                   text[] not null check (
                             cardinality(scopes) between 1 and 2
                             and scopes <@ array['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose']::text[]
                             and 'https://www.googleapis.com/auth/gmail.readonly' = any(scopes)),
  refresh_token_encrypted  text check (refresh_token_encrypted like 'enc:%'),
  access_token_encrypted   text check (access_token_encrypted like 'enc:%'),
  access_expires_at        timestamptz,
  -- Excerpts of this mailbox may go to cloud AI only when the user allows it (default off).
  cloud_ai_allowed         boolean not null default false,
  status                   text not null default 'active' check (status in ('active', 'revoked', 'error')),
  last_error               text check (last_error is null or length(last_error) <= 300),
  connected_at             timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (user_id, provider)
);
create trigger mail_connections_updated_at before update on mail_connections for each row execute function app.set_updated_at();

create table whatsapp_chats (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users (id) on delete cascade,
  title_encrypted    text not null check (title_encrypted like 'enc:%'),
  my_name_encrypted  text check (my_name_encrypted like 'enc:%'),
  file_sha256        text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  format             text not null check (format in ('android', 'ios')),
  date_order         text not null check (date_order in ('dmy', 'mdy')),
  message_count      integer not null check (message_count between 1 and 20000),
  first_message_at   timestamptz,
  last_message_at    timestamptz,
  cloud_ai_allowed   boolean not null default false,
  imported_at        timestamptz not null default now(),
  -- Imported chats are deleted automatically after this date (default 30 days, user-changeable).
  expires_at         timestamptz not null default now() + interval '30 days',
  unique (user_id, file_sha256)
);
create index whatsapp_chats_expiry_idx on whatsapp_chats (expires_at);

create table whatsapp_messages (
  id                uuid primary key default gen_random_uuid(),
  chat_id           uuid not null references whatsapp_chats (id) on delete cascade,
  user_id           uuid not null references users (id) on delete cascade,
  seq               integer not null check (seq >= 1),
  sent_at           timestamptz,
  sender_encrypted  text check (sender_encrypted like 'enc:%'),
  from_me           boolean not null default false,
  kind              text not null check (kind in ('text', 'media_omitted', 'deleted', 'system')),
  text_encrypted    text not null check (text_encrypted like 'enc:%'),
  unique (chat_id, seq)
);

create table message_insights (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users (id) on delete cascade,
  source             text not null check (source in ('gmail', 'whatsapp')),
  -- Gmail thread id, or a whatsapp_chats id.
  ref                text not null check (length(ref) between 1 and 64),
  content_encrypted  text not null check (content_encrypted like 'enc:%'),
  provider           text check (provider in ('local', 'gemini', 'rules')),
  task_id            uuid references tasks (id) on delete set null,
  created_at         timestamptz not null default now()
);
create index message_insights_ref_idx on message_insights (user_id, source, ref, created_at desc);

create table message_drafts (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references users (id) on delete cascade,
  channel               text not null check (channel in ('gmail', 'whatsapp')),
  connection_id         uuid references mail_connections (id) on delete set null,
  thread_ref            text not null check (length(thread_ref) between 1 and 64),
  reply_to_ref          text check (reply_to_ref is null or length(reply_to_ref) <= 200),
  -- Gmail: JSON list of recipient addresses taken from the thread headers (never from model output).
  recipients_encrypted  text check (recipients_encrypted like 'enc:%'),
  subject_encrypted     text check (subject_encrypted like 'enc:%'),
  body_encrypted        text not null check (body_encrypted like 'enc:%'),
  task_id               uuid references tasks (id) on delete set null,
  idempotency_key       text not null check (length(idempotency_key) between 8 and 120),
  status                text not null default 'draft' check (status in ('draft', 'approved', 'created', 'failed', 'discarded', 'copied')),
  approved_content_sha  text check (approved_content_sha is null or approved_content_sha ~ '^[0-9a-f]{64}$'),
  approved_at           timestamptz,
  gmail_draft_id        text check (gmail_draft_id is null or length(gmail_draft_id) <= 100),
  error                 text check (error is null or length(error) <= 300),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (user_id, idempotency_key),
  -- WhatsApp drafts are only ever copied by the user: no "approved/created" channel exists.
  check (channel = 'gmail' or status in ('draft', 'copied', 'discarded')),
  check (channel = 'whatsapp' or recipients_encrypted is not null),
  -- A Gmail draft is created only for approved content.
  check (status not in ('approved', 'created') or (approved_content_sha is not null and approved_at is not null)),
  check (status <> 'created' or gmail_draft_id is not null)
);
create index message_drafts_user_idx on message_drafts (user_id, created_at desc);
create trigger message_drafts_updated_at before update on message_drafts for each row execute function app.set_updated_at();

-- References must stay within one user.
create or replace function app.messaging_same_owner() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if tg_table_name = 'whatsapp_messages' then
    if not exists (select 1 from whatsapp_chats c where c.id = new.chat_id and c.user_id = new.user_id) then
      raise exception 'chat belongs to another user';
    end if;
  end if;
  return new;
end $$;
create trigger whatsapp_messages_owner before insert or update on whatsapp_messages for each row execute function app.messaging_same_owner();

create or replace function app.message_draft_same_owner() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if new.connection_id is not null and not exists (select 1 from mail_connections m where m.id = new.connection_id and m.user_id = new.user_id) then
    raise exception 'connection belongs to another user';
  end if;
  if new.channel = 'whatsapp' and not exists (select 1 from whatsapp_chats c where c.id::text = new.thread_ref and c.user_id = new.user_id) then
    raise exception 'chat belongs to another user';
  end if;
  return new;
end $$;
create trigger message_drafts_owner before insert or update on message_drafts for each row execute function app.message_draft_same_owner();

do $$
declare t text;
begin
  foreach t in array array['oauth_states', 'mail_connections', 'whatsapp_chats', 'whatsapp_messages', 'message_insights', 'message_drafts'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy %I on %I for all to ufa_app using (user_id = app.current_user_id()) with check (user_id = app.current_user_id())', t || '_own', t);
  end loop;
end $$;

grant select, insert on oauth_states to ufa_app;
grant update (used_at) on oauth_states to ufa_app;
grant select, insert, update, delete on mail_connections to ufa_app;
grant select, insert, delete on whatsapp_chats to ufa_app;
grant update (cloud_ai_allowed, expires_at, my_name_encrypted) on whatsapp_chats to ufa_app;
grant select, insert, delete on whatsapp_messages to ufa_app;
grant select, insert, delete on message_insights to ufa_app;
grant select, insert, update, delete on message_drafts to ufa_app;
