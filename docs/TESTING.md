# Testing

| Command | What it runs |
|---|---|
| `npm test` | Unit tests (vitest, project `unit`): validators, catalog, roles, password hashing, encryption, tokens, rate limiter, redaction, profile decision engine, completion, file storage + encryption, file-type checks, document extractors, local-AI client (mocked), real OCR |
| `npm run test:db` | Integration tests (project `db`) on a throwaway **PostgreSQL 16** started via `embedded-postgres` (no Docker needed): migrations, idempotency, RLS isolation, column grants, café session lifecycle, bank exclusion, snapshot immutability, append-only audit, document pipeline grants/policies |
| `npm run test:all` | Both |
| `npm run typecheck` / `npm run lint` | TypeScript (all packages + web) / ESLint |

The unit project includes a real OCR test (`packages/document-engine/src/ocr.test.ts`): it renders a synthetic marksheet image and runs Tesseract with the bundled language data, fully offline. All test documents are synthetic — never commit real ID documents.

To run DB tests against an existing empty database instead (e.g. Docker):

```bash
TEST_DATABASE_URL=postgres://owner:pw@localhost:54320/ufa_test \
TEST_DATABASE_APP_URL=postgres://ufa_app:test_app_password_1234@localhost:54320/ufa_test \
npm run test:db
```

## Manual end-to-end check (phase 1)

1. `npm run dev:db`, `npm run db:migrate`, `npm run dev`.
2. Sign up → you land on the dashboard with a "verify your email" banner. The code is printed in the dev console.
3. Profile → Family → add Father's Name "Raj Kumar" → edit to "Rajesh Kumar" → the app asks *"You currently have Raj Kumar saved and verified. Update it?"* → confirm → History shows CREATE then UPDATE.
4. Identity → add a PAN → it is shown masked; "Show" reveals it (audited); the database row starts with `enc:`.
5. Privacy → Download JSON exports everything; access history lists the events.

## Manual check (phase 2)

1. Documents → upload an Aadhaar image → status goes Queued → Reading… → "N to review".
2. Open it: preview on the left, values with confidence and source on the right. Confirm DOB.
3. Upload a 10th marksheet with a different DOB → "Needs your decision": choose the correct one → profile updated, the other value rejected.
4. Profile → the value shows source "Document ↗" linking to the file.

## Manual check (phase 3)

1. AI Assistant → "My father's name is Raj Kumar." → card → Save.
2. "What is the name of my father?" → "Your Father's Name is Raj Kumar."
3. "My father's name is Rajesh Kumar." → *"I currently have "Raj Kumar" saved … update it to "Rajesh Kumar"?"* → Yes, update → profile history shows both.
4. Hindi: "मेरी माता का नाम सुनीता देवी है" → reply in Hindi; Hinglish: "Maine 2022 mein B.Com complete kiya".
5. "my aadhaar is …" → the stored message shows the number masked.

## Manual check (phase 4)

1. `npm run build:extension`, load `apps/extension/dist` unpacked in Chrome, sign in from the side panel.
2. `npm run test-form` → open http://localhost:4000 → Analyze form: ~28 fields, sections incl. Hindi, "Manual action required" for CAPTCHA/OTP.
3. Choose Country = India, State = Uttar Pradesh → the panel reports the new District field.
4. http://localhost:4000/spa → switch steps → the panel re-reads the form.
5. Without installing the extension: http://localhost:4000/__dev/harness runs the built panel next to the form.

## Manual check (phase 5)

1. Profile with some values, open the test form, Analyze → "N fields · M profile match · K missing · X% confidence"; each field shows Ready / Review / Needs you / Manual with the value it would use.
2. "Father / Guardian Name" → Review (ambiguous). ✗ Change → Guardian's Name → Analyze again → recognised from your knowledge (~97%).
3. Optional local AI: `LOCAL_AI_ENABLED=true`, `ollama pull qwen2.5:7b-instruct` (and `nomic-embed-text` for `LOCAL_AI_EMBED_MODEL`) → unknown labels get AI suggestions; calls appear in `ai_requests`.

## Manual check (phase 7)

1. `npm run dev` (+ `npm run dev:db`), then `node scripts/seed-dev-user.mjs` — creates a local test customer with sample profile data; credentials go to `.data/dev-test-user.json` (git-ignored).
2. `npm run test-form` → http://localhost:4000/__dev/harness signs in as that user automatically (dev-only, loopback-only `/__dev/session`).
3. Analyze → 12 fields pre-ticked → **Review & fill 12** → preview (Category shows `UR` for profile "General") → **Confirm & fill** → "Filled 12 of 12", green outlines; date, radio, select filled.
4. **Undo fill** → form empty again, application `CANCELLED`. Fill again → **I submitted this form** with a number → `SUBMITTED`.
5. Automated: `packages/form-engine/src/fill.test.ts` (value preparation) and `dom/fill.test.ts` (filler on the test form: events, native setter, ARIA combobox, skips, undo, no submit); `database/tests/rls.test.ts` (0006 guards).

## Manual check (phase 8)

1. After the phase 7 check: http://localhost:4000/__dev/dashboard signs the dev test user in to the web dashboard (dev-only, loopback-only).
2. **Applications** → "Needs your attention" lists filled-but-not-submitted forms; **History** → search `REG-0001`, filter by status/date, **Export CSV**.
3. Open an application → snapshot in page order, timeline, **Save form**, link a document, edit the application number.
4. Back in the harness, Analyze → "You applied here before … View" and "★ Saved form".
5. Automated: `database/tests/rls.test.ts` (0007: foreign document ids rejected, links removable only by the owner, saved-form URL immutable and unique).

## Manual check (phase 9)

1. Harness: fill the test form → Dashboard → **Learning** shows 12 learned fields (source "Used in a form you filled") and 12 examples.
2. In the form frame add a field (dev tools) and Analyze again → "This form changed since you applied … 1 new field".
3. Learning → **Forget** a mapping → count drops; toggle sharing / withdraw.
4. Automated: `packages/ai/src/learning/learning.test.ts` (promotion rules, label rules, votes, change diff, stale weight) and
   `database/tests/rls.test.ts` (end-to-end `runLearning` with several users, opt-out demotion, RLS on shared knowledge).

## Manual check (phase 10)

1. `node scripts/seed-dev-user.mjs` (customer) and `node scripts/seed-dev-cafe.mjs` (café owner + café); credentials in `.data/` (git-ignored).
2. http://localhost:4000/__dev/dashboard → **Café access** → *Create code*.
3. http://localhost:4000/__dev/harness?as=cafe → café bar → type the code → "Filling for <customer>, 60 min left" → Analyze → values are the customer's → fill.
4. Customer: Café access shows the active session, "1 form filled" and the café log → **Stop access now** → the next panel request fails with "session has ended".
5. http://localhost:4000/__dev/dashboard?as=cafe → Café Workspace: reports, operators (invite), request access.
6. Automated: `database/tests/rls.test.ts` café block (no re-opening, 12-hour cap, never extended, parties fixed, values only while allowed, codes private) and `packages/security/src/accessCode.test.ts`.

## Manual check (phase 11)

1. `npm run ml -- evaluate --dataset benchmark --model rules` → baseline metrics (100 % / 0 % wrong on the hand-written benchmark).
2. `npm run ml -- dataset` → with few confirmations the dataset is `DRAFT` with "Only N examples (minimum 50)" (by design).
3. `npm run ml -- benchmark-dataset`, then register / evaluate (`predictions:<file>`) / promote / rollback a candidate; a poor candidate is refused with reasons.
4. Python: `python ml/training/train_lora.py --help` (training itself needs a GPU box).
5. Automated: `packages/ai/src/training/training.test.ts` (eligibility, PII, dedupe/conflicts, split, records = inference prompt, metrics, gate), `mapping/semantic.test.ts` (vector store + fallback), `database/tests/rls.test.ts` (0011).

## Manual check (phase 12)

1. `node scripts/seed-dev-admin.mjs` (local SUPER_ADMIN; credentials in `.data/dev-admin.json`). Admin pages need two-step verification (phase 13): with the app running, `node scripts/seed-dev-admin.mjs --mfa` turns it on and stores the secret in the same file. Then http://localhost:4000/__dev/dashboard?as=admin → **Admin**.
2. Overview: real counts and 30-day charts. Learning review: approve a label → field; reject requires a note.
3. Users → open a user: counts only, no values. Suspend (with reason) → that user can no longer sign in; reactivate. Your own account and admins have no actions; SUPER_ADMIN cannot be assigned.
4. Cafés → suspend → the café's sessions end. Models → promote / roll back (same gate as the CLI). Audit log shows every admin action with its reason.
5. Automated: `apps/web/src/server/admin/admin.privacy.test.ts` (no personal-data access, permission checks first), `database/tests/rls.test.ts` (0012 suspended café).

## Manual check (phase 13)

1. **Two-step verification**: Settings → Two-step verification → Set up → scan the QR/secret in an authenticator app →
   enter a code + password → recovery codes shown once. Sign out and in: a code is asked; a wrong code fails; a recovery
   code works once. Turn it off again with password + code. Web login and the extension both show the code step.
2. **Admin needs 2FA**: an admin without 2FA opening `/dashboard/admin` lands on Settings with a notice; admin APIs answer 403.
3. **Notifications**: sign in from a new browser → "New sign-in" notification; bell shows the unread count; Mark all read.
4. **Account deletion**: Privacy & Access → Delete account (wrong password fails) → banner with the date, other sessions
   signed out, café access ended → Cancel deletion. A café owner is asked to close the café first.
   To test the purge locally set `ACCOUNT_DELETION_GRACE_DAYS=1`, schedule, then move `deletion_scheduled_for` into the
   past in psql; the job (hourly, first run 1 min after start) removes everything.
5. **Monitoring**: `curl localhost:3000/api/health?deep=1`; `curl -H "Authorization: Bearer $METRICS_TOKEN" localhost:3000/api/metrics`
   (without the header: 404).
6. **Load test** (production build: `npm run build && npm start`): `node scripts/load-test.mjs -c 50 -d 15` and
   `node scripts/load-test.mjs --scenario map -c 5 -d 20 --login .data/dev-test-user.json` (expect 429s after 60 maps/min per user — that is the rate limit working; see `successLatency_ms`).
7. **Security headers**: `curl -sI localhost:3000/login` shows CSP, COOP, CORP, X-Frame-Options, Permissions-Policy.
8. Automated: `packages/security/src/totp.test.ts` (RFC 6238 vectors), `database/tests/rls.test.ts` (0014: MFA secret
   unreadable, statement timeout, full erasure, audit links nulled, other snapshots still immutable).

## Mock providers

`MockAIProvider` (packages/ai/src/providers/mock.ts) answers from a fixed table and records what it was asked, so tests
assert that only labels/types (never profile values) reach a model. `packages/ai/src/gemini.test.ts` tests `GeminiProvider` against a stubbed `fetch` (request shape, header auth, retry, missing key) and the engine's cache/budget/opt-out paths. For an end-to-end check without a real key, point `GEMINI_BASE_URL` at a local HTTP stub that answers `:generateContent` — but a stub cannot catch request-format mistakes, so run `npm run check:gemini` against the real API after changing the provider or the model.
