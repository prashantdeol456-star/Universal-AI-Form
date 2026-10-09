# Existing project audit — Universal AI Form Assistant

Audit date: 9 October 2026. Scope: the working copy at the repository root (it is **not a git repository**, so no
history, branches or blame could be inspected). Method: reading code, migrations and docs, plus the commands listed
in §6. No application code, schema, secrets or deployment configuration were changed for this audit.

Status words used below:

- **Implemented** — code exists and is covered by automated tests or was exercised end to end in this session.
- **Partial** — code exists but with a known functional gap.
- **Unverified** — code exists but has not been run in the environment that matters (real Chrome, real site, VPS).
- **Planned** — documented only; no code.
- **Broken** — fails when run. (None found.)

## 1. Actual architecture

| Area | What the code shows | Evidence |
|---|---|---|
| Monorepo | npm workspaces: `apps/web`, `apps/extension`, `apps/test-form`, `packages/{ai,db,document-engine,form-engine,profile-engine,security,shared,storage}`, `ml/` | `package.json`, `packages/` |
| Web app | Next.js 15.5.27 App Router, React 19.3, route handlers under `apps/web/src/app/api/**/route.ts` (≈80 routes), server modules in `apps/web/src/server/` | `apps/web/package.json`, `apps/web/src/server/http.ts` (`route()`, `parseBody`, `rateLimit`) |
| Validation | zod schemas at every route boundary | `apps/web/src/app/api/**/route.ts` |
| Database | PostgreSQL 16; 15 SQL migrations applied in order with a checksum per file in `schema_migrations`; edited migrations are refused | `database/migrations/0001…0015`, `packages/db/src/migrate.ts` |
| Isolation | Row-level security on user tables; requests run as role `ufa_app` with `app.user_id` set per transaction (`withUser` / `asUser`); a separate owner pool (`db().system`) bypasses RLS for jobs and admin services | `database/migrations/0002_rls.sql`, `packages/db/src/client.ts`, `apps/web/src/server/db.ts` |
| Auth | Own implementation: scrypt passwords, opaque DB sessions (cookie for web, bearer token for the extension), email OTP verification, reset links, TOTP 2FA with recovery codes, role permissions | `apps/web/src/server/auth/{service,session,mfa}.ts`, `packages/security/src/{password,tokens,totp}.ts`, `packages/shared/src/roles.ts` |
| Storage | Encrypted files on local disk (Docker volume), HMAC-signed short-lived download URLs | `packages/storage/src/index.ts`, `apps/web/src/server/documents/service.ts` (`signedFileUrl`) |
| Encryption | AES-256-GCM with key ring `DATA_ENCRYPTION_KEYS` for sensitive profile values, snapshots, document text, saved answers | `packages/security/src/encryption.ts`, `apps/web/src/server/db.ts` (`encryptValue`) |
| AI providers | `AIProvider` interface; `LocalAIProvider` (Ollama HTTP), `GeminiProvider` (REST, key in header, JSON-schema output), `MockAIProvider`; `AIOrchestrator` runs rules → knowledge base → fuzzy → embeddings → local → Gemini for **field mapping only** | `packages/ai/src/providers/*.ts`, `packages/ai/src/orchestrator.ts`, `packages/ai/src/mapping/` |
| Other AI uses | Email drafting and open-answer drafting call Gemini directly from their own services (three separate `new GeminiProvider` sites, no shared router) | `apps/web/src/server/{mapping,compose,agent}/service.ts` |
| Extension | MV3; permissions `sidePanel, storage, scripting, activeTab`; optional host permissions `http(s)://*/*`; content script injected on demand; React side panel; session token in `chrome.storage.session` (or `local` with "remember me") | `apps/extension/src/manifest.json`, `apps/extension/src/content.ts`, `apps/extension/src/sidepanel/storage.ts` |
| DOM engine | Detection, filling (native + ARIA controls, shadow DOM, iframes), visible cursor/typing, upload-field attach, email insert — all in `packages/form-engine/src/dom/` | `detect.ts`, `fill.ts`, `visual.ts`, `upload.ts`, `email.ts` |
| Documents | Upload → magic-byte type check → optional ClamAV → encrypted store → Postgres-queue worker → tesseract.js OCR (eng+hin) / PDF text → rule extraction (+ optional local AI) → user review | `apps/web/src/server/documents/{service,worker}.ts`, `packages/document-engine/src/` |
| Background jobs | In-process timers started from `instrumentation-node.ts`: document worker, learning scheduler, café maintenance, account purge. No general task queue. | `apps/web/src/instrumentation-node.ts` |
| Monitoring | `/api/health` (+ `?deep=1`), Prometheus text at `/api/metrics` behind `METRICS_TOKEN`, request timing in `route()` | `apps/web/src/app/api/{health,metrics}/route.ts`, `apps/web/src/server/metrics.ts` |
| Deployment | Docker Compose: `postgres` (pgvector image), `migrate`, `web`, `caddy`; optional `ollama`, `clamav` profiles; Caddy for HTTPS | `docker-compose.yml`, `Dockerfile`, `docker/caddy/Caddyfile`, `docs/DEPLOYMENT.md` |
| ML | Python LoRA training, export and inference scripts; TypeScript dataset/evaluation/registry CLI (`npm run ml`) | `ml/`, `packages/ai/src/training/` |
| Tests | vitest projects `unit` (packages, web, extension) and `db` (embedded PostgreSQL); happy-dom for DOM tests | `vitest.config.ts`, `database/tests/rls.test.ts` |

### 1.1 Documentation drift found

- `PRD` §10 names tables `model_registry` and `audit_log`; the schema has **`model_versions`**, **`model_evaluations`** and **`audit_logs`**.
- `cafe_access_codes`, `learning_runs`, `model_evaluations` and `label_embeddings` are created with `create table if not exists` (the last one only when pgvector exists), so a plain grep for `create table` misses them.
- PRD says "Phases 1–13 shipped": true for code and tests; **none of it has been deployed to the VPS in this audit**, so "shipped" means "built and tested locally".

## 2. Feature verification

| Feature | PRD status | Actual code status | Evidence | Gap | Recommendation |
|---|---|---|---|---|---|
| Sign-up, login, sessions, email OTP, reset | Shipped | Implemented | `server/auth/service.ts`, `app/api/auth/*`; DB tests on `auth_tokens` | SMTP not configured locally (codes printed to console) | Configure SMTP before launch |
| Two-step verification, admin MFA | Shipped | Implemented | `server/auth/mfa.ts`, `packages/security/src/totp.ts` (RFC vectors), `requireUser` admin gate | TOTP code reusable within its window | Store last used time step (small change) |
| Profile catalog and editing | Shipped | Implemented | `packages/shared/src/profile/catalog.ts`, `server/profile/service.ts`, history table | — | — |
| Job-portal profile fields | Shipped | Implemented | catalog keys `employment.skills…needs_visa_sponsorship`; mapping rules in `packages/ai/src/mapping/rules.ts` | Only one current job; no list of past jobs or projects | Add structured experience/projects for job search (§D) |
| Document upload and OCR | Shipped | Implemented | `documents/service.ts`, `worker.ts`, `document-engine/src/ocr.ts` | PDF and images only | Add DOCX/TXT first (cheap); XLSX later |
| CV extraction | Shipped | Implemented (rules) | `document-engine/src/extract/rules.ts` `resume()`; tested on the owner's CV (field names only) | Only latest job and up to two degrees; one-line formats only | Section-aware parser + review UI for lists |
| Document text as knowledge | — (PRD FR-14 planned) | Planned | `extracted_text` is written encrypted by `worker.ts:164`; **nothing reads it** | No retrieval over document content | Chunk + embed on the VPS (pgvector) or locally; consent-gated |
| Form detection and mapping | Shipped | Implemented | `form-engine/src/dom/detect.ts`, `ai/src/mapping/*`, 105-label benchmark in tests | Cross-origin iframes need site permission | — |
| Confirmed filling + snapshot | Shipped | Implemented | `server/applications/service.ts`, migration 0006 status trigger | — | — |
| Visible filling (cursor, typing) | Shipped | Implemented, **unverified in real Chrome** | `form-engine/src/dom/visual.ts`, test in `dom/fill.test.ts`; exercised in the dev harness | Not run in an installed extension on a live site | Manual check in Chrome (test plan §5) |
| Document attach to upload fields | Shipped | Implemented, unverified on live sites | `form-engine/src/dom/upload.ts`, `app/api/extension/documents/[id]/attach`; harness test | Workday/others not tested live | Manual check on Workday-style portal |
| "Fill everything" agent | Shipped | Partial | `sidepanel/MainView.tsx` `fillEverything()`, `sidepanel/agent.ts` | State lives in side-panel memory; closing the panel loses the run; one page only; no pause/resume; no persisted task | Server-side task model (§D) |
| Chat learns facts | Shipped | Implemented | `server/agent/service.ts` `absorbMessage`, `ai/src/chat/facts.ts` `jobSearch()`; tests | Rules only; misses free phrasing | Add local-model extraction as fallback |
| Saved answers | Shipped | Implemented | migration 0015, `server/agent/service.ts`, `/dashboard/answers`; DB test | Exact wording match only | Keep exact; add "similar question" suggestions needing confirmation |
| Open-answer drafting | Partial | Partial | `agent/service.ts` `draftAnswer`, `ai/src/compose` `answerSystemPrompt` | Gemini drafts may add unsupported phrases (observed in live API runs of email drafting) | Claim checker against facts before showing |
| Email drafting / insert | Shipped | Implemented, unverified on live Gmail/Outlook | `server/compose/service.ts`, `form-engine/src/dom/email.ts` tests | No attachments, no sending | Gmail API (OAuth) for drafts with attachments; send only after approval |
| Café mode | Shipped | Implemented | `server/cafe/*`, migration 0010/0012, DB tests | — | — |
| Learning engine | Shipped | Implemented | `ai/src/learning/*`, `server/learning/service.ts`, scheduler | — | — |
| ML pipeline | Shipped | Implemented, GPU training **unverified** | `ml/`, `ai/src/training/*` | pgvector and training never run here | Run once on VPS / GPU box |
| Admin panel | Shipped | Implemented | `server/admin/*`, `admin.privacy.test.ts` | — | — |
| Notifications | Shipped | Implemented (in-app only) | `server/notifications.ts` | No push / email for agent events | Add for background tasks |
| Security controls | Shipped | Implemented | `docs/SECURITY_REVIEW.md`, headers in `apps/web/next.config.ts`, RLS tests | In-memory rate limits; CSP `unsafe-inline` | See risks |
| Task history | Planned | Planned (absent) | no task tables or routes | — | §D task model |
| Pause / resume / checkpoints | Partial (Stop) | Stop only | `stopAgent()` in `MainView.tsx` | No persisted progress | §D |
| Job discovery / CV matching | — | Absent | no code | — | New module (§D) |
| Model router (local-first) | Planned | Partial | `AIOrchestrator` covers mapping only | Compose/answers bypass it | Generalise router |
| Deployment | Shipped (docs) | Configured, **not deployed** | `docker-compose.yml`, `docs/DEPLOYMENT.md` | Never brought up on the VPS in this project | First deploy + smoke test |

## 3. Risk assessment

### 3.1 Things that could break during expansion

- `apps/extension/src/sidepanel/MainView.tsx` holds form filling, café mode **and** the agent in one ~1030-line component; adding a task engine there will cause regressions. Extract the agent before extending it.
- Mapping service caches the orchestrator on `globalThis` (`g.__ufaOrchestrator`); catalog changes need a server restart (seen during this session).
- `confirmApplication` is the only path that writes application snapshots; any new automation must go through it or the history/snapshot guarantees break.
- Migrations are checksummed: never edit 0001–0015; add new files.

### 3.2 Sensitive data exposure

- Open-answer drafting can send the professional profile to Gemini after consent (`profiles.ai_profile_sharing`). Consent is global, not per request.
- Saved answers may hold personal free text; they are encrypted but returned in full to the owner's extension.
- The extension can keep the session token in `chrome.storage.local` when "remember me" is on; any other extension compromise or local malware could read it.
- `extracted_text` (full document text) is stored encrypted; a future knowledge base must not send it to cloud AI without explicit consent.

### 3.3 Unsafe browser actions

- `onChatSend` opens **any URL** pasted into chat via `chrome.tabs.update` and then starts filling (`MainView.tsx`). There is no allowlist or confirmation for unknown domains.
- "Allow on all websites" grants `http(s)://*/*`. Reading is on demand, but the grant is broad and long-lived.
- The filler uses synthetic DOM events (`isTrusted = false`); some sites ignore them, giving silent partial fills (reported per field, but not re-verified after the page reacts).
- No re-verification that a value is still present a few seconds after filling (frameworks may reset it).

### 3.4 Authentication and sessions

- Extension bearer tokens live up to the session lifetime; no per-device scoping beyond the session row; revocation exists (`/account/sessions`).
- Rate limits are per process memory (`packages/security/src/rateLimit.ts`); a restart or second container resets them.

### 3.5 Prompt injection

- Page labels and question text are sent to Gemini (mapping, open answers). Mapping output is constrained to an enum of profile keys (safe). **Open-answer output is free text typed into the page**: a hostile page could word a "question" to steer the answer (e.g. ask it to include contact details). Facts sent are limited to summary/skills/job/education, which bounds the damage, but there is no output check.
- Document text is not yet sent to any model; when a knowledge base is added it becomes an injection channel.

### 3.6 Database isolation

- Admin and background services use the owner pool (bypasses RLS). This is guarded by `assertAdmin` and a source-level privacy test for `server/admin/*` only; the new `agent` and `compose` services use `asUser` (good), but nothing tests that future agent code stays on `asUser`.

### 3.7 Background task recovery

- Server jobs are timers in the web process; a crash loses in-flight work (the document worker re-claims queued rows, others simply rerun).
- The agent has no persisted state: browser restart, panel close or navigation away loses progress and there is nothing to resume.

### 3.8 External website limits

- LinkedIn and Naukri terms prohibit automated access and scraping; automating search or "Easy Apply" there risks account bans. Official job APIs for LinkedIn are partner-only.
- CAPTCHA, OTP and login walls stop automation by design (and must).
- Workday and similar ATSs vary per tenant; untested live.

### 3.9 Production gaps

- Never deployed; SMTP, backups, `METRICS_TOKEN`, Gemini key on the VPS all unconfigured.
- Web production build not re-run in this audit (dev server shares `.next`; see §6).
- No CI pipeline (no git repository).
- No external penetration test.

## 4. What could not be inspected

- Git history, authorship and previous versions (no `.git`).
- The live VPS, DNS, Caddy certificates, production `.env`.
- Real third-party sites (Workday tenants, Gmail, Outlook, LinkedIn, Naukri) — only local test pages that imitate them.
- GPU training and pgvector at runtime (the local embedded PostgreSQL has no pgvector).

## 5. Gap summary for the "Personal AI Browser" vision

| Vision item | Exists today | Missing |
|---|---|---|
| Natural-language commands (EN/HI/Hinglish) | Chat facts + "fill" command + URL open | Intent → plan → steps; multi-step tasks |
| Document understanding and knowledge base | OCR, extraction, verified facts | Retrieval over document text; DOCX/TXT |
| Job discovery and CV matching | — | Everything |
| Form filling and attachments | Yes (single page) | Multi-page, verification, recovery |
| Recruiter emails | Draft + insert | Attach, send with approval, OAuth |
| Task tracking, checkpoints, retries | — | Task store, executor, resume |
| Approvals and policies | Implicit (user clicks) | Explicit policy engine, approval records |
| Background work + notifications | Server timers, in-app notifications | User tasks that run while away |

## 6. Commands run for this audit

| Command | Result |
|---|---|
| `npm run typecheck` | pass (all workspaces) |
| `npm run lint` | pass |
| `npm test` | 24 files, **209 tests passed** |
| `npm run test:db` | 1 file, **33 tests passed** (embedded PostgreSQL 16) |
| `npm run build:extension` | success |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm run build` (web) | **not run**: the local dev server on port 3001 uses the same `.next` folder and a concurrent build corrupts it (observed earlier in this project) |
