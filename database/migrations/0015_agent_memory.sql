-- Agent memory (assistant in the extension).
--
-- saved_answers: answers the user gave (in chat or in the side panel) to form questions
-- that are not profile fields ("How did you hear about us?", "Tell us about yourself").
-- Reused only for the same question wording; the user can edit or delete them.
-- Values are encrypted by the application (AES-GCM) like profile values.
create table saved_answers (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users (id) on delete cascade,
  question         text not null check (char_length(question) between 1 and 500),
  question_norm    text not null check (char_length(question_norm) between 1 and 500),
  answer           text not null,
  field_kind       text,
  domain           text,
  use_count        integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  last_used_at     timestamptz
);
create unique index saved_answers_user_question on saved_answers (user_id, question_norm);
create trigger saved_answers_updated_at before update on saved_answers
  for each row execute function app.set_updated_at();

alter table saved_answers enable row level security;
alter table saved_answers force row level security;
grant select, insert, update, delete on saved_answers to ufa_app;
create policy saved_answers_own on saved_answers for all to ufa_app
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());

-- Consent to send the user's professional profile (summary, skills, job, education —
-- never ID numbers, contact details or family data) to the cloud AI to write answers.
alter table profiles add column ai_profile_sharing boolean not null default false;
