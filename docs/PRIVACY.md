# Privacy

| Promise | How |
|---|---|
| You control what is stored | Every profile value shows its source and verification status; you can edit, delete and see history |
| Sensitive identifiers are protected | Encrypted at rest (AES-256-GCM), masked in the UI, reveal is audited |
| Admins cannot browse your profile | No database policy gives super admins access to profile values |
| Cafés see only what you approve | Time-limited, per-category sessions you approve and can revoke; bank details never |
| You can take your data | Privacy & Access → Download JSON (profile, documents list, applications with their filled values, sessions, access history) |
| Chat history does not keep raw ID numbers | Aadhaar, PAN, account numbers are masked before a chat message is stored |
| Administrators cannot read your data | The admin dashboard shows counts (how many fields, documents, applications) and account metadata — never values, documents, filled forms or chats. Admin actions on your account appear in your access history |
| Cafés see only what you allow | Café access: choose categories and time, untick anything in a request, stop at any time; bank details can never be shared; after the session the café cannot see the values it filled; every café action is in your café log |
| Training data has no personal data | Datasets contain field labels and target fields only, from confirmations by several people; anything that looks like personal data is dropped; withdrawn contributions are excluded |
| Learning is structure-only and optional | Only "label X on site Y is field Z" is learned — never values. Shared knowledge needs several different people; you can turn sharing off, forget single mappings, or withdraw all contributions (Dashboard → Learning) |
| Minimal data to third-party AI | Gemini (only if the operator enabled it and you did not switch it off in Settings → AI assistance) receives the field label, section, type and options of fields nothing else could map, plus the list of profile field **keys** — never your values, documents or the page URL. Answers are cached by field structure only. Privacy page shows how many fields were sent |
| Learning is anonymised (phase 9) | Only field-label → field-key patterns are shared globally; never values |
| The assistant remembers only what you give it | Answers you type to form questions are stored encrypted under Dashboard → Saved Answers (edit or delete any time) and erased with your account. AI-written answers use your summary, skills, job and education only after you press Allow (switch it off on the same page) |
| Email drafts reveal nothing to the AI | "Write email" sends Gemini only your request (ID numbers, e-mail addresses and phone numbers masked) and the names of profile details; your values are filled in on our server. Identity, bank, caste and family details never go into an email automatically. Drafts are not stored, and nothing is sent for you |

## Account deletion (phase 13)

Dashboard → Privacy & Access → **Delete account** (password required).

- **Immediately**: all your other devices are signed out; café sessions and unused access codes end; operator access (if
  you work for a café) is disabled; sharing with the learning engine is switched off and your past contributions are
  withdrawn (`REMOVED`, so they are excluded from shared knowledge and future training datasets). You get an e-mail and a
  notification, and a banner shows the date.
- **Grace period** (`ACCOUNT_DELETION_GRACE_DAYS`, default 30): you can still sign in, download your data and cancel.
- **Permanent deletion**: an hourly job erases every row that belongs to you — profile, documents and their encrypted
  files, chats, applications including snapshots, mappings, saved forms, sessions, notifications — and your e-mail
  address can be used again. This cannot be undone.
- **Audit retention**: audit entries stay (security and legal reasons) but lose the link to you; they never contained
  values. A `privacy.account_deleted` entry records that the erasure happened.
- Café owners must close their café first (Café Workspace → Close café). Super admin accounts are removed with the server CLI.
