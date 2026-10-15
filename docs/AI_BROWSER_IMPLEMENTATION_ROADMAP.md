# Implementation roadmap — Personal AI Browser

Ordered so that each phase is usable on its own and can be rolled back without touching earlier ones. Every phase:
new migration files only (never edit 0001–0015), RLS tests for new tables, `npm run typecheck && npm run lint && npm
test && npm run test:db && npm run build:extension && npm run build` green before it is called done.

## Status (14 October 2026)

| Phase | Status |
|---|---|
| 0 — Groundwork | **Done**, except the first VPS deploy (needs the owner's server access and secrets) |
| 1 — Persistent tasks | **Done** (15 October 2026) — see "Phase 1 — implemented" below; browser-step execution is deliberately left for Phase 2 |
| 2 — Safer browser actions | **Done** (15 October 2026) — see "Phase 2 — implemented" below. D-15 (focus-only comboboxes) still open |
| 3–6 | Not started |
| 7 — WhatsApp | Design only (`AI_BROWSER_WHATSAPP_DESIGN.md`) |

## Phase 0 — Groundwork (no new features)

| Item | Detail | Result |
|---|---|---|
| Version control | `git init`, first commit of the current tree, `.gitignore` check for `.env*`, `.data/` | Done: baseline `5480ba4`; `.gitignore` extended (keys, certificates, logs, local DB files, uploads, local Claude settings); staged files scanned for keys, tokens and the owner's contact details (none) |
| Split the side panel | Move the agent out of `apps/extension/src/sidepanel/MainView.tsx` into its own module; no behaviour change | Done (`6356621`): `useAssistantAgent.ts`, `FormSummary.tsx`, `CafeBar.tsx`; `MainView.tsx` 1030 → 397 lines; moved code verified line by line against the baseline |
| Shared model router | Replace the three `new GeminiProvider` sites with one router call per purpose; behaviour unchanged | Done (`6356621`): `packages/ai/src/router.ts` + `apps/web/src/server/ai/router.ts`; mapping, email and answer drafting migrated; future purposes reserved and refuse to run; `AI_ROUTING_MODE` (default `hybrid`) |
| First VPS deploy | Bring up the existing compose stack, configure SMTP, backups, `METRICS_TOKEN`; smoke test | **Not done** — out of reach from this machine; no deployment config was changed |
| Acceptance | All existing tests pass; side panel behaves identically (manual checklist in test plan §5.1) | Met — see test plan §8 |
| Rollback | Revert the refactor commit; nothing persisted changes | `git revert 6356621` (no schema or data changes) |

Found during the Phase 0 regression run (both pre-existing, not caused by the refactor):

1. **Fixed** (`b80310c`): "Fill everything" pre-selected dropdowns whose profile value matched no option; the server
   then rejected the whole fill. Such fields are now asked in chat.
2. **Open — needs approval**: custom comboboxes that open their list on the `focus` event are not filled when the
   page's window is not focused (the side panel has focus), because `element.focus()` then fires no `focus` event.
   Reproduced in the harness (`fillCombobox` in `packages/form-engine/src/dom/fill.ts` → `option_not_found`).
   Proposed fix: when `document.hasFocus()` is false, dispatch `focus`/`focusin` after `focus()`. Changes filler
   behaviour on every site, so it waits for approval (Phase 2 "safer browser actions" is the natural place).

## Phase 1 — Persistent tasks (foundation for everything else)

| Item | Detail |
|---|---|
| Schema | `tasks`, `task_steps`, `task_events`, `approvals` (RLS: owner only; admin counts via owner pool) |
| Server | `/api/tasks` create/list/get/pause/resume/cancel; step claim with lease; event log |
| Extension | Background runner claims browser steps; "Fill everything" becomes a task; timeline UI; Pause / Resume / Stop |
| Verify-before-retry | Each step type has `verify()`; retry only when verify fails |
| Acceptance | Closing and reopening the panel resumes a paused fill at the next unfinished field; a crashed step is retried once and never double-fills |
| Rollback | Feature flag `TASKS_ENABLED=false` falls back to the current in-panel agent |

### Phase 1 — implemented

**Migration** `0016_task_engine.sql` (forward-only; 0001–0015 untouched):

| Table | Key points |
|---|---|
| `tasks` | status, priority, `input_json`, `result_json`, `checkpoint_json`, error code/message, `idempotency_key` (unique per user), lease (`lease_owner`, `lease_token`, `lease_expires_at`), `attempt_count`, timestamps incl. `started_at`, `completed_at`, `cancelled_at`, `last_checkpoint_at`; `unique (id, user_id)` |
| `task_steps` | `step_type` = `server.*` / `browser.*` / `approval.*`, `idempotent`, `sequence_number` (unique per task), `result_json`, **`result_secret`** (AES-GCM, for drafts/answers), attempts, errors |
| `task_events` | append-only history (`bigint` identity), message ≤ 500 chars, no content |
| `approvals` | `action_type`, `action_summary`, `requested_payload_json` + **`payload_hash`** (binds the approval to one action), `pending/approved/rejected/expired`, `expires_at`, **`consumed_at`** (single use); trigger `app.approvals_guard` makes decisions final and forbids re-targeting |

All four tables: RLS forced, owner-only policies for `ufa_app`; steps/events/approvals reference `(task_id, user_id)` so a row
cannot point at another user's task; the runtime role cannot update/delete events or insert approvals.

**State machines** (`packages/shared/src/tasks.ts`):

```
task: queued → running | waiting_for_browser | waiting_for_approval | paused | completed | failed | cancelled
      running → queued | waiting_for_browser | waiting_for_approval | paused | completed | failed | cancelled
      waiting_for_browser → running | paused | failed | cancelled
      waiting_for_approval → queued | paused | failed | cancelled
      paused → queued | cancelled          failed → queued | cancelled          completed, cancelled: final
step: pending → running | waiting | skipped | cancelled
      running → completed | failed | waiting | pending | cancelled
      waiting → running | completed | failed | pending | cancelled
      failed → pending | cancelled         completed, skipped, cancelled: final
```

Every change goes through `assertTaskTransition` / `assertStepTransition` (typed `TaskTransitionError`, HTTP 409) and the SQL
update repeats the expected "from" status, so concurrent writers cannot both win.

**Engine** (`packages/tasks`, wired in `apps/web/src/server/tasks/engine.ts`, runner in `runner.ts`, started from
`instrumentation-node.ts`, switch `TASKS_RUNNER_ENABLED`):

- Claim: `FOR UPDATE SKIP LOCKED` + random lease token + `lease_expires_at` (2 min). One step per claim; result committed
  with the step (= checkpoint), lease released.
- Expired lease: task back to `queued`; an **idempotent** step runs again, any other step becomes `waiting` with
  `needs_verification` and the task `paused` — retry then requires `confirmUncertain: true`.
- Pause wins over a running step (the step's result is kept, the next step does not start); cancel discards a running
  step's result; completed/cancelled are final; retries re-run only failed/unverified steps, max 3 attempts per step.
- Approvals: created when an `approval.*` step is reached (TTL 7 days); approving lets the runner perform the step's effect
  **once** in the user's transaction together with `consumed_at`; a changed payload (hash mismatch) fails the step; reject
  fails the task (cancels it if it was paused); expiry fails the task, retry asks again.
- Task types: `draft_email` (compose → approval "mark as ready", nothing sent), `draft_answers` (one draft per question →
  approval "save to Saved Answers"), `fill_form` (browser steps; waits in `waiting_for_browser` — **execution is Phase 2**).
- Secrets: task inputs have passwords/OTPs/PINs/tokens stripped; worker payload keys that look like credentials are
  refused (422); error messages are redacted and capped; events never contain draft text.

**API** (all `requireUser()`, owner from the session, zod-validated, rate-limited):

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/api/tasks` | list (`status`, `limit` ≤ 50, cursor `beforeCreatedAt` + `beforeId`) / create (`taskType`, `title?`, `description?`, `input`, `priority?`, `idempotencyKey?` → 201 or 200 for a repeat) |
| GET | `/api/tasks/:id` | task, ordered steps (owner sees decrypted output), approvals |
| GET | `/api/tasks/:id/events` | history, newest first (`limit` ≤ 200, `before`) |
| POST | `/api/tasks/:id/control` | `{action: pause \| resume \| cancel \| retry, stepId?, confirmUncertain?}` |
| POST | `/api/approvals/:id` | `{decision: approve \| reject, note?}` |
| POST | `/api/tasks/worker/claim` | the user's extension claims its next browser step (own tasks only) |
| POST | `/api/tasks/:id/steps/:stepId/report` | progress / completed / failed / uncertain, with the lease token |
| POST | `/api/tasks/:id/checkpoint` | save checkpoint, with the lease token |

**UI**: dashboard `/dashboard/tasks` (filters, cursor pagination, new-task form with idempotency key) and
`/dashboard/tasks/:id` (steps with outputs + copy, approval card, controls incl. "I checked" confirmation, history,
auto-refresh while live); extension **Tasks** tab (list, detail, steps, recent events, approve/reject, pause / resume /
cancel / retry; polls only while open).

**Known limitations / deferred**

- The extension does not execute browser steps yet (`fill_form` tasks wait); the claim/report/checkpoint API is in place
  and tested. Phase 2.
- The runner is an in-process timer per web container (safe with several containers thanks to leases).
- Drafts are viewed in the dashboard; the extension links there instead of showing them.
- In Next.js dev, the engine is cached on `globalThis`: restart the dev server after changing engine code.
- Gemini returned 429/503 during the live checks, so drafts came from templates; the AI path is covered by stubbed tests.

## Phase 2 — Safer browser actions

| Item | Detail |
|---|---|
| Action allowlist | Typed actions only; URL open requires the domain to be on the user's allowlist or a confirmation |
| Approval manager | Policy table + approval records; hard `never` list |
| Post-fill verification | Re-read values after 1–2 s; report fields the page reset |
| Validation errors | Read error text near fields after fill; ask the user or fix with a known value |
| Multi-page | `click_next` action gated by per-task approval; re-read after navigation |
| Acceptance | A 3-page test form completes with approvals; a URL to an unknown domain asks first; tampered page text cannot trigger an action outside the list |
| Rollback | Policies default to `ask`; disabling the flag restores single-page behaviour |

### Phase 2 — implemented

What changed from the plan above: there is **no `click_next` action**. Next / Continue / Submit stay with the user on
every site (D-25); a multi-page form continues when the user says "I moved to the next page". Validation-error reading
is deferred (Phase 3).

| Part | Where | What it does |
|---|---|---|
| URL policy | `packages/form-engine/src/policy.ts` `checkUrl`, `sameOrigin` | https only (http only for `localhost`, `127.0.0.1`, `[::1]`, `*.localhost`, `*.test`); rejects `javascript:`, `data:`, `file:`, `blob:`, `chrome:`, `about:`, user:password@ and control characters. Subdomains and ports are different sites |
| Action policy | `policy.ts` `decideAction` | Fixed action list. Grantable scopes per site: `inspect`, `fill`, `attach_file`, `insert_text`. **Never grantable**: `submit`, `click_next`, `pay`, `send_message`, `create_account`, `solve_captcha`, `enter_otp`, `enter_password`. `open_url` needs the user's review of the exact address |
| Site permissions | migration `0017_site_permissions.sql`, `apps/web/src/server/sites/service.ts`, `/api/sites`, `/api/sites/:id` | Per user + origin, scopes checked by a DB constraint, forced RLS, audit `site.authorized` / `site.revoked`. **Enforced on the server**: form analyze/map (`inspect`), application confirm (`fill`), document attach (`attach_file`), adding a task page (`fill`) → 403 `site_not_allowed` |
| Chrome permission | `apps/extension/src/sidepanel/siteAccess.ts` | One origin at a time, requested from the click (`chrome.permissions.request`) before the server grant; "Remove access" revokes both. The old "Allow on all websites" button is gone |
| Page inspection | `packages/form-engine/src/dom/inspect.ts` | Structured, size-limited view: headings, instructions, forms (action origin, cross-site flag, buttons with role), **visible** fields only (hidden ones counted), injection signals (visible text, hidden text, labels), `javascript:` links |
| Injection defence | `packages/form-engine/src/injection.ts`, `text.ts` `manualReasonFor` | Page text can never choose an action (fixed list + policy). Detection only warns: a field whose label gives orders to an assistant becomes manual (`suspicious`); payment fields (card, CVV, UPI PIN, `cc-*`) become manual (`payment`) |
| Preview | `apps/extension/src/sidepanel/Fill.tsx` | Every value shows its source (profile key, verified or not, label / earlier match / AI) and confidence; "Use a different value for this form" replaces a profile value for this form only |
| Controlled fill | `packages/form-engine/src/dom/fill.ts` | Before typing, the element's live signature must equal the reviewed one (`stale_element`); existing values are kept unless the user ticked overwrite; password / OTP / CAPTCHA / payment / file / hidden fields are never typed into |
| Verification | `packages/form-engine/src/dom/verify.ts` | Re-reads each filled field: `verified`, `mismatch`, `missing`, `stale`; shown in the result view and stored in the task step result |
| Task integration | `apps/extension/src/sidepanel/fillTask.ts`, `apps/web/src/server/tasks/engine.ts`, `packages/tasks` `addPage` | `fill_form` = `read_1` (checkpoint url + form signature) → `fill_1` (re-checks the page, fills, verifies; `uncertain` pauses the task when fields vanish) → review approval. "I moved to the next page" adds `read_n`/`fill_n` (same origin only, max 50 pages) and re-asks the approval with payload `{origin, pages}`. "All pages done" approves it; **nothing is submitted** |
| Documents | `Uploads.tsx`, agent | Only on sites with `attach_file`. The panel attaches the file the user picked; the assistant asks "Attach your CV … to …?" per field (Attach / Skip) |
| Assistant | `useAssistantAgent.ts` | Reads only allowed sites; a pasted link is shown for review (Open / Cancel) and nothing is filled after opening; before filling it lists every value and waits for "Fill these"; fills through the task and reports verification |
| Email insert | `Compose.tsx` | Needs `insert_text` on the mail site ("Allow inserting text on this site") |

**Known limitations / deferred**

- Tested on the local test pages only (apply, jobs, mail, the new hostile `injection.html`); no claim about real sites.
- Validation-error reading after fill and D-15 (focus-only comboboxes) are not done.
- Injection detection is pattern based and English only; it is a warning, not the defence.
- `optional_host_permissions` still lists `http://*/*` so a self-hosted server on plain http (e.g. a VPS IP before
  HTTPS) can be reached; page access itself is limited to https and local http by `checkUrl`.
- Site permissions are managed in the side panel only (no dashboard page yet).

## Phase 3 — Knowledge base

| Item | Detail |
|---|---|
| Formats | DOCX and TXT extraction (small libraries); XLSX/CSV later |
| Chunks | `document_chunks` (encrypted text, embedding, document id), built by the worker |
| Retrieval | `knowledge.search(user, query)` returning chunk ids + scores; used by `draft_answer` |
| Consent | Per-document "may be sent to cloud AI" flag; default off |
| Claim checker | Rejects or flags draft sentences with facts not found in profile/answers/chunks |
| Acceptance | "Describe your AI experience" is answered from the CV text with citations to the chunks; no claim outside them in the test set |
| Rollback | Drafting falls back to profile-only facts |

## Phase 4 — Job discovery and matching

| Item | Detail |
|---|---|
| Sources | Current page; public Greenhouse/Lever boards; manual URLs; optional Gmail job-alert label (Phase 5 OAuth) |
| Schema | `job_sources`, `job_listings`, `job_matches`, `job_applications` (links to `applications`) |
| Matching | Filters (location, salary, experience, work authorization) + embedding similarity + short explanation |
| UI | Dashboard "Jobs" list with match reasons; "Apply" creates a Phase 1 task |
| Acceptance | For a seeded CV and 50 sample listings, top 10 contains all hand-labelled good matches; no requests to LinkedIn/Naukri |
| Rollback | Module behind `JOBS_ENABLED` |

## Phase 5 — Email and messages

| Item | Detail |
|---|---|
| Gmail OAuth | `gmail.compose` scope; tokens encrypted; revoke button |
| Drafts with attachments | Create Gmail draft with the chosen document; idempotency key prevents duplicates |
| Sending | Default: user presses Send in Gmail. Optional policy: approve-to-send recorded in `approvals` |
| Acceptance | Recruiter email with CV attached appears once in Gmail Drafts; a retry does not create a second draft |
| Rollback | Disconnect OAuth; DOM insert remains |

## Phase 6 — Background work and local companion (optional)

| Item | Detail |
|---|---|
| Server jobs | Searches and drafts continue while the browser is closed; notifications when approval is needed |
| Companion | Native-messaging host: local Ollama, local document index, Playwright for permitted public pages |
| Acceptance | Local-only mode completes mapping and drafting with no Gemini calls (verified in `ai_requests`) |
| Rollback | Uninstall companion; server path unaffected |

## Phase 7 — WhatsApp Intelligence Agent (future; design only)

Full design: `docs/AI_BROWSER_WHATSAPP_DESIGN.md`. Not implemented; the router purposes `understand_whatsapp` and
`draft_whatsapp_reply` are reserved and refuse to run.

| Stage | Detail |
|---|---|
| 7a — personal chats, user-controlled | Upload a WhatsApp chat export or paste text → summary, "needs reply" list, drafted replies; the user sends from WhatsApp. No WhatsApp access at all |
| 7b — business number | WhatsApp Business Platform Cloud API: webhook for the connected business number only, encrypted storage, approval before every send, 24-hour service window respected, idempotent sends |
| 7c — coexistence (optional) | For WhatsApp Business **app** users via Embedded Signup v4 |
| Never | Reading personal chats through unofficial clients, session cookies or hidden browser automation; bulk or unsolicited messages |
| Acceptance (7a) | Summary and drafts cite the source messages; nothing leaves the server without per-chat consent; deleting the chat removes all its data |
| Depends on | Phase 1 (tasks, approvals), Phase 3 (document handling) |

## Dependencies

```
Phase 0 → Phase 1 → Phase 2 → Phase 4 (apply flow)
                 ↘ Phase 3 → Phase 4 (matching quality)
Phase 1 → Phase 5
Phase 3 → Phase 6 (local index)
Phase 1 + Phase 3 → Phase 7 (WhatsApp)
```
