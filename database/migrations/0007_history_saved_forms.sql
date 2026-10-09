-- Phase 8: application history, saved forms, document links.

-- Document links: only the customer's own documents may be linked to their own
-- application (an FK check alone would accept any guessed document id), and a
-- link can be removed again. Links do not belong to the immutable value snapshot.
drop policy if exists application_documents_insert on application_documents;
create policy application_documents_insert on application_documents for insert to ufa_app
  with check (
    exists (
      select 1 from applications a
       where a.id = application_id
         and a.customer_id = app.current_user_id()
    )
    and exists (
      select 1 from documents d
       where d.id = document_id
         and d.user_id = app.current_user_id()
         and d.deleted_at is null
    )
  );

grant delete on application_documents to ufa_app;
create policy application_documents_delete on application_documents for delete to ufa_app
  using (exists (select 1 from applications a where a.id = application_id and a.customer_id = app.current_user_id()));

-- Saved forms: one live bookmark per URL and user; remember when it was last used.
alter table saved_forms add column if not exists last_used_at timestamptz;
create unique index if not exists saved_forms_user_url_unique on saved_forms (user_id, url) where deleted_at is null;
revoke update on saved_forms from ufa_app;
grant update (name, notes, deleted_at, last_used_at, form_signature_id) on saved_forms to ufa_app;

-- History search: by status, newest first.
create index if not exists applications_customer_status_idx on applications (customer_id, status, created_at desc);
