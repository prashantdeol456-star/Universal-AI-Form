# Implementation roadmap — Personal AI Browser

Ordered so that each phase is usable on its own and can be rolled back without touching earlier ones. Every phase:
new migration files only (never edit 0001–0015), RLS tests for new tables, `npm run typecheck && npm run lint && npm
test && npm run test:db && npm run build:extension && npm run build` green before it is called done.

## Phase 0 — Groundwork (no new features)

| Item | Detail |
|---|---|
| Version control | `git init`, first commit of the current tree, `.gitignore` check for `.env*`, `.data/` |
| Split the side panel | Move the agent out of `apps/extension/src/sidepanel/MainView.tsx` into its own module; no behaviour change |
| Shared model router | Replace the three `new GeminiProvider` sites with one router call per purpose; behaviour unchanged |
| First VPS deploy | Bring up the existing compose stack, configure SMTP, backups, `METRICS_TOKEN`; smoke test |
| Acceptance | All existing tests pass; side panel behaves identically (manual checklist in test plan §5.1) |
| Rollback | Revert the refactor commit; nothing persisted changes |

## Phase 1 — Persistent tasks (foundation for everything else)

| Item | Detail |
|---|---|
| Schema | `tasks`, `task_steps`, `task_events`, `approvals` (RLS: owner only; admin counts via owner pool) |
| Server | `/api/tasks` create/list/get/pause/resume/cancel; step claim with lease; event log |
| Extension | Background runner claims browser steps; "Fill everything" becomes a task; timeline UI; Pause / Resume / Stop |
| Verify-before-retry | Each step type has `verify()`; retry only when verify fails |
| Acceptance | Closing and reopening the panel resumes a paused fill at the next unfinished field; a crashed step is retried once and never double-fills |
| Rollback | Feature flag `TASKS_ENABLED=false` falls back to the current in-panel agent |

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

## Dependencies

```
Phase 0 → Phase 1 → Phase 2 → Phase 4 (apply flow)
                 ↘ Phase 3 → Phase 4 (matching quality)
Phase 1 → Phase 5
Phase 3 → Phase 6 (local index)
```
