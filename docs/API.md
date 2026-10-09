# REST API

Base: `APP_URL/api`. JSON in/out. Errors: `{ "error": { "code", "message", "details?" } }`.

Auth: web uses the `ufa_session` httpOnly cookie; the extension sends `Authorization: Bearer <token>` (obtained from login
with `"client": "extension"`). Cookie-authenticated `POST/PUT/PATCH/DELETE` must come from `APP_URL` (Origin check, CSRF).

| Status | Code | Meaning |
|---|---|---|
| 401 | `unauthorized` | Not signed in / bad credentials |
| 403 | `forbidden` | Role lacks permission, or cross-site request |
| 409 | `conflict` | Would overwrite verified data — resend with `confirmOverwrite: true` after asking the user |
| 422 | `validation_error` | Input failed schema validation (`details[]` per field) |
| 423 | `locked` | Too many failed logins (15 min) |
| 429 | `rate_limited` | `Retry-After` header set |

## Auth

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/auth/signup` | `{ fullName, email, password, accountType: "CUSTOMER"\|"CAFE_OWNER" }` | Creates account, profile, session; emails a 6-digit code |
| POST | `/auth/login` | `{ email, password, client?: "web"\|"extension" }` | Extension receives `{ token, expiresAt }`. With two-step verification on: `{ mfaRequired: true, mfaToken }` instead |
| POST | `/auth/login/mfa` | `{ mfaToken, code, client? }` | Authenticator code or a recovery code (used up); token valid 5 min, 5 attempts; then same response as login |
| POST | `/auth/logout` | — | Revokes current session |
| GET | `/auth/me` | — | Current user |
| POST | `/auth/verify-email` | `{ code }` | 5 attempts per code, 15 min expiry |
| POST | `/auth/verify-email/resend` | — | |
| POST | `/auth/forgot-password` | `{ email }` | Always 200 (no account enumeration) |
| POST | `/auth/reset-password` | `{ token, password }` | Revokes all sessions |

## Account

| Method | Path | Body |
|---|---|---|
| POST | `/account/password` | `{ currentPassword, newPassword }` — signs out other sessions |
| GET | `/account/sessions` | — |
| DELETE | `/account/sessions/:id` | — |
| GET | `/account/mfa` | — → `{ enabled, recoveryCodesLeft }` |
| POST | `/account/mfa` | `{ action: "setup" }` → `{ secret, uri }` · `{ action: "enable", password, code }` → `{ recoveryCodes }` (shown once) · `{ action: "disable", password, code }` — 10 per 15 min |
| POST | `/account/deletion` | `{ password }` → `{ scheduledFor }` — signs out other sessions, ends café access, withdraws learning contributions |
| DELETE | `/account/deletion` | — cancel during the grace period |

## Notifications

| Method | Path | Body |
|---|---|---|
| GET | `/notifications` | — → latest notifications + `unread` |
| POST | `/notifications` | `{ ids: [uuid, …] }` or `{ ids: "all" }` — mark read |

## Profile

| Method | Path | Body / query | Notes |
|---|---|---|---|
| GET | `/profile` | — | Fields (sensitive values masked), custom field definitions, completion report |
| PUT | `/profile/fields` | `{ fieldKey, value, confirmOverwrite? }` | Validated per field; returns `created\|updated\|verified\|unchanged` or 409 |
| DELETE | `/profile/fields?key=` | — | Soft delete + history |
| GET | `/profile/history?key=` | — | Last 50 changes (sensitive values masked) |
| POST | `/profile/reveal` | `{ fieldKey }` | Decrypted value for the owner; audited; `no-store` |
| POST | `/profile/custom-fields` | `{ label, dataType, options?, isSensitive?, value? }` | Key becomes `custom.<slug>` |

## Documents

| Method | Path | Body / query | Notes |
|---|---|---|---|
| GET | `/documents` | — | Own documents with processing status and review counts |
| POST | `/documents` | multipart: `file`, `documentType`, `title?` | 413 too large, 415 unsupported type, 422 unsafe/corrupt, 409 duplicate. 30/hour |
| GET | `/documents/:id` | — | Detail, extracted values (full, `no-store`), current profile value per field, signed `fileUrl` (5 min) |
| GET | `/documents/:id/file?t=` | `download=1` optional | Signed URL **and** session + RLS check; decrypted on the fly; sandboxed CSP |
| DELETE | `/documents/:id` | — | Soft delete; file removed unless a saved application uses it (`fileRetained`) |
| POST | `/documents/:id/reprocess` | — | Re-run scan/OCR/extraction |
| POST | `/documents/extractions/:id` | `{ action: "confirm", value? }` or `{ action: "reject" }` | Confirm writes the profile (source `document`); **409 `{status:"conflict", conflictId}`** if it disagrees with a verified value |

## Conflicts

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/conflicts` | — | Open conflicts with all candidate values and their sources |
| POST | `/conflicts/:id/resolve` | `{ chosenIndex }` or `{ customValue }` | Updates the profile, confirms matching extractions, rejects the rest |

## Chat assistant

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/chat/sessions` | — | Own conversations |
| GET / DELETE | `/chat/sessions/:id` | — | Messages with their proposals / soft delete (pending proposals are withdrawn) |
| POST | `/chat/messages` | `{ sessionId?, content }` | Creates the session if needed. Returns the stored user message (sensitive numbers masked) and the assistant reply with proposals. 30/min |
| POST | `/chat/proposals/:id` | `{ action: "accept" \| "reject" }` | Accept writes the profile (source `chat`, verified); an `UPDATE` proposal is the explicit overwrite confirmation |
| POST | `/chat/replies/:id/accept-all` | — | Saves all pending **new** values of one reply (updates of existing values always need individual answers) |

## Extension

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/auth/login` | `{ email, password, client: "extension" }` | Returns a bearer token. Allowed from `chrome-extension://` origins without cookies |
| POST | `/extension/forms/analyze` | `FormSnapshot` (validated by `formSnapshotSchema`) | Records the form structure in `form_signatures` (no values, no query string). Returns `{ formSignatureId, seenBefore, firstSeenAt }`. Domain must match the URL. 120/min |

## Assistant (extension)

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/extension/assistant/message` | `{ text }` | Everyday facts in the message are saved to the profile (`source: chat`); sensitive ones are reported as skipped. 60 per 10 min |
| POST | `/extension/assistant/answer` | `{ question, answer, profileFieldKey?, kind?, domain? }` | Profile field → profile (validated, history); otherwise `saved_answers` (encrypted, one per question wording). 120 per 10 min |
| POST | `/extension/assistant/draft` | `{ question, role?, maxWords? }` | Answer to an open question. Gemini only with `ai_profile_sharing` consent, otherwise a template from the user's own text. 30 per 10 min |
| GET | `/extension/documents` | — | Own documents that may be attached to upload fields (metadata only) |
| POST | `/extension/documents/:id/attach` | `{ domain }` | File bytes for an upload field; audited as `document.attached_to_page`. 30 per 10 min |
| GET / PATCH / DELETE | `/answers`, `/answers/:id` | `{ answer }` | Manage saved answers |
| POST | `/account/ai-sharing` | `{ enabled }` | Consent for AI-written answers (audited) |

## Write email (extension)

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/extension/compose` | `{ instruction (3–1000), tone: "formal"\|"friendly", language: "en"\|"hi"\|"hinglish", previous?: { subject, body } }` | Returns `{ subject, body, template, source: "gemini"\|"template", notice, used[], missing[{key,label}] }`. `template` holds placeholders only and is sent back as `previous` to ask for a change. Gemini gets the request (identifiers masked) and placeholder **names**; values are filled on the server. Template fallback when Gemini is off, opted out, failing or over `COMPOSE_DAILY_LIMIT` (default 30/day). 20 per 10 min. Never sends email; not stored |

## Form mapping (extension)

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/extension/forms/map` | `FormSnapshot` | Records the signature and returns per field: profile field, value (masked if sensitive), matched option, confidence, decision, reason, evidence sources, top candidates; plus stats (`fields`, `matched`, `missingValues`, `averageConfidence`, …) and `engine` (`localAi`, `semantic`, `gemini`: `off / not_needed / used / cached / limit_reached / failed`, `geminiFields`, `cloudAiAllowed`). 60/min |
| POST | `/extension/mappings/feedback` | `{ domain, field: { signature, label, language }, suggestedKey, correctKey, provider? }` | `correctKey` = a profile field or `"__none__"` (not a profile field). Writes a USER mapping (+ failure on the wrong one, + `learning_corrections`); for a Gemini suggestion also marks it confirmed/corrected |
| GET / PATCH | `/account/preferences` | `{ cloudAiEnabled: boolean }` | Per-user opt-out of Gemini (cloud AI). Audited |

## Applications (extension)

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/extension/applications` | `{ url, domain, formTitle, pageTitle, formSignatureId, items: [{ field, source: "profile" \| "manual", profileFieldKey, manualValue?, confidence, aiProvider }] }` | Called only after the user clicks **Confirm & fill**. The server reads profile values itself (never trusts client values), matches options, rejects CAPTCHA/OTP/password/upload fields and unknown keys, stores the encrypted snapshot, returns `{ applicationId, instructions: [{ fieldId, value, valueType, option, overwrite }] }`. `no-store`, 30/min |
| POST | `/extension/applications/:id/events` | `{ type: "FILLED", results: [{ fieldId, status, reason? }] }` or `{ type: "UNDONE", restored }` | Statuses only, never values |
| PATCH | `/extension/applications/:id` | `{ status?: "SUBMITTED" \| "CANCELLED", applicationNumber? }` | Only from `CONFIRMED`; "I submitted this form" (the user submits on the website) |

## History & saved forms

| Method | Path | Body / query | Notes |
|---|---|---|---|
| GET | `/applications` | `?q=&status=&from=YYYY-MM-DD&to=YYYY-MM-DD&page=&pageSize=` | Search history (form name, website, URL, application number) |
| GET | `/applications/export` | same filters | CSV download (metadata only, formula-safe, UTF-8 BOM), 10/min |
| GET | `/applications/:id` | — | Details: snapshot (sensitive values masked), timeline, linked + linkable documents |
| PATCH | `/applications/:id` | `{ status?: "SUBMITTED" \| "CANCELLED", applicationNumber? }` | From the dashboard |
| POST | `/applications/:id/reveal` | — | Unmasked snapshot values for the owner; audited (`application.values_revealed`), 20/min |
| POST | `/applications/:id/documents` | `{ links: [{ documentId, label? }] }` | Own documents only |
| DELETE | `/applications/:id/documents/:documentId` | — | Remove a link |
| GET / POST | `/saved-forms` | `{ name, url, notes?, formSignatureId? }` | POST is idempotent per URL (`created: false` if it exists); query strings are dropped from URLs |
| PATCH / DELETE | `/saved-forms/:id` | `{ name?, notes? }` | Soft delete |

`POST /extension/forms/map` now also returns `previousApplications` (your filled/submitted applications for this form) and `savedForm`.

## Learning

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/learning` | — | Your learned mappings, stats, contribution setting, community knowledge counts |
| PATCH | `/learning` | `{ contributionEnabled: boolean }` | Audited |
| DELETE | `/learning/mappings/:id` | — | Forget one of your mappings |
| POST | `/learning/withdraw` | — | Stop contributing and mark all your examples REMOVED; audited |

`POST /extension/forms/map` also returns `formChange: { added, removed, lastAppliedAt } | null`.
`POST /extension/mappings/feedback` accepts optional `field.section`, `field.kind`, `field.options` (structure for learning examples).

## Café (café owner / operator)

| Method | Path | Body | Notes |
|---|---|---|---|
| GET / POST / PATCH | `/cafe` | `{ name, phone?, address?, city?, state?, pincode? }` | My café / register (café owner) / edit |
| GET / POST | `/cafe/operators` | `{ fullName, email }` | Owner: list / invite (new work account + set-password e-mail) |
| POST | `/cafe/close` | — | Owner: closes the café for good — sessions end, operators lose access (needed before the owner can delete their account) |
| PATCH | `/cafe/operators/:id` | `{ status: "ACTIVE" \| "DISABLED" }` | Disabling ends the operator's sessions |
| GET | `/cafe/sessions?active=1` | — | Owner: all; operator: own |
| POST | `/cafe/sessions/request` | `{ identifier, permissions[], purpose? }` | Always `{ sent: true }` (no account discovery); 20/h |
| POST | `/cafe/sessions/redeem` | `{ code }` | Customer's one-time code → active session; 10 per 10 min per operator, 30 per IP |
| POST | `/cafe/sessions/:id/end` | — | End early |
| GET | `/cafe/reports?days=30` | — | Owner: counts + form metadata, no values |
| GET | `/extension/cafe` | — | Side panel: café + customers this operator can fill for now |

`POST /extension/forms/map?cafeSession=<id>` and `POST /extension/applications` with `cafeSessionId` fill for a customer;
`403 cafe_session_ended` when the session is gone.

## Café access (customer)

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/cafe-access` | — | Requests, active/past sessions, live code, café log |
| POST | `/cafe-access/sessions/:id` | `{ action: "approve", permissions[], durationMinutes }` / `{ action: "reject" }` / `{ action: "revoke" }` | Approve only a subset of what was asked |
| POST | `/cafe-access/codes` | `{ permissions[], durationMinutes, purpose? }` | Returns the code once; 10/h |
| DELETE | `/cafe-access/codes/:id` | — | Cancel |

## Other

| Method | Path | Notes |
|---|---|---|
| GET | `/dashboard/stats` | Counts and percentages from real data only |
| GET | `/privacy/export` | JSON download of all own data; audited; 5/hour |
| GET | `/health` | `{status:"ok"}` or 503 when the DB is unreachable. `?deep=1`: also migrations, document worker heartbeat, document queue |
| GET | `/metrics` | Prometheus text format. Requires `Authorization: Bearer $METRICS_TOKEN`; 404 when the token is unset or wrong |
