# Target architecture — Personal AI Browser

Builds on the system described in `AI_BROWSER_EXISTING_PROJECT_AUDIT.md`. Principle: **extend, don't replace**. The VPS
app, PostgreSQL schema, RLS, form engine and Chrome extension stay; new parts are added beside them.

## 1. Component map

```
┌───────────────────────────── User's computer ─────────────────────────────┐
│ Chrome (user's own profile and logins)                                     │
│  ├─ Extension side panel  — Command Center chat, task timeline, approvals  │
│  ├─ Background service worker — task runner, tab/navigation watcher        │
│  └─ Content script (on demand) — read page, fill, attach, insert text      │
│                                                                            │
│ Optional Local Companion (Node, Native Messaging host)                     │
│  ├─ Local model runtime client (Ollama on localhost)                       │
│  ├─ Local document index (embeddings of the user's own files)              │
│  └─ Playwright runner for allowlisted, ToS-permitted public pages only     │
└──────────────────────────────┬─────────────────────────────────────────────┘
                               │ HTTPS, bearer token (no cookies)
┌──────────────────────────────┴─────────── Hostinger VPS ───────────────────┐
│ Caddy → Next.js app (existing)                                             │
│  ├─ Auth, profile, documents, applications, café, admin (existing)         │
│  ├─ Task service (new): tasks, steps, approvals, checkpoints, events        │
│  ├─ Model router (new; generalises AIOrchestrator)                         │
│  ├─ Knowledge service (new): verified facts + document chunks (pgvector)   │
│  ├─ Job service (new): sources, listings, match scores, tracker            │
│  └─ Workers (existing timers → one job runner with leases)                 │
│ PostgreSQL 16 + pgvector (existing, RLS)    Encrypted file volume          │
│ Optional: Ollama container, ClamAV                                         │
└────────────────────────────────────────────────────────────────────────────┘
        │ only with consent and budget
        ▼
 Google Gemini API (cloud fallback)      Gmail API (OAuth, drafts) — optional
```

## 2. Decisions per component

| # | Component | Recommendation | Runs where | Reuses |
|---|---|---|---|---|
| 1 | AI Command Center | Extend the side-panel `AssistantChat` into the main surface: free-text command → plan preview → run. Same chat also in the dashboard (`/dashboard/assistant`) for non-browser tasks (search, drafting). | Extension + web | `AssistantChat.tsx`, `server/agent/service.ts`, `ai/src/chat` |
| 2 | Orchestrator + task queue | **Server-side task store** (tasks, steps, approvals, events) with a lease-based runner. Browser steps are *claimed* by the extension; server steps (search, drafting, matching) run on the VPS. | VPS (state), extension (browser steps) | Postgres queue pattern from `documents/worker.ts` |
| 3 | Electron/Chromium browser | **Not now.** Users already have Chrome with their logins; a second browser duplicates sessions, raises security surface and maintenance. Revisit only if the extension model blocks a must-have (e.g. trusted input events at scale). | — | — |
| 4 | Chrome extension | Keep as the browser executor. Add: background task runner, typed action allowlist, per-domain permissions, re-verification after each action. Split `MainView.tsx` (fill UI) from the agent. | User's Chrome | everything in `apps/extension` |
| 5 | Controlled automation | DOM actions via the content script (existing). **Playwright only** in the optional companion, for public pages whose terms allow it (e.g. public ATS job boards), never for LinkedIn/Naukri accounts. `chrome.debugger` (trusted input) only behind an explicit per-task opt-in. | Extension; companion | `form-engine/src/dom/*` |
| 6 | Local AI | Ollama on the user's PC (via companion) **or** the existing optional `ollama` container on the VPS. Router prefers it for classification, extraction, mapping and short drafts. | PC or VPS | `LocalAIProvider` |
| 7 | Gemini | Keep server-only key. One provider instance behind the router; per-purpose consent flags (mapping labels: default on; professional profile: explicit; document text: explicit per document); daily budgets per purpose. | VPS | `GeminiProvider` |
| 8 | Model router | Generalise `AIOrchestrator` into `ModelRouter.run(purpose, input, policy)` with purposes: `map_fields`, `extract_facts`, `draft_email`, `draft_answer`, `match_job`, `plan_task`. Policy = local-only / hybrid / cloud-preferred + budget + consent. All calls logged to `ai_requests`. | VPS | `orchestrator.ts`, `ai_requests`, `ai_usage` |
| 9 | Knowledge base | Two layers: **verified facts** (existing `profile_fields`, `saved_answers`) and **document chunks** (new table, encrypted text + embedding). Retrieval returns chunk ids; text is decrypted server-side only for the requesting user. Cloud models receive chunks only with per-document consent. | VPS (pgvector) or local index | `extracted_text`, `label_embeddings` pattern |
| 10 | Job discovery + matching | Sources in order of safety: (a) the page the user has open (read on request); (b) public ATS feeds (Greenhouse, Lever, Workday public search where permitted); (c) job-alert emails the user forwards / Gmail label via OAuth; (d) manual URLs. No automated LinkedIn/Naukri scraping. Match = rule filters (location, salary, experience) + embedding similarity CV↔JD + explanation. | VPS | profile, knowledge base |
| 11 | Form filling + attach | Existing engine; add multi-page loop (Next with approval), post-fill verification, validation-error reading, and per-task document-attach permission. | Extension | `fillEverything`, `upload.ts` |
| 12 | Email / messages | Keep DOM insert for any webmail. Add Gmail API (OAuth, `gmail.compose` scope) to create drafts **with attachments**; sending = user clicks Send in Gmail, or an approval record in our app (never automatic by default). Idempotency key per message. | VPS (OAuth tokens encrypted) | `compose/service.ts`, `email.ts` |
| 13 | Approval manager | Policy table: action type × domain × scope → `ask` / `allow-once` / `allow-for-task` / `never`. Approval records with who/when/what (hash of payload). Hard-coded `never` list: CAPTCHA, OTP, passwords, payments. | VPS + extension UI | `audit_logs` |
| 14 | History, checkpoints, retry, pause/resume | Task steps are idempotent with a verify function; checkpoint after each verified step; retry only if verify says "not done"; pause = runner stops claiming; resume = continue from last checkpoint after re-reading the page. | VPS + extension | `application_events` pattern |
| 15 | Notifications, audit, admin | Reuse `notifications` (+ optional email / web push) for "needs approval", "failed", "done". Admin sees task counts and failure rates only. | VPS | `notifications.ts`, `server/admin/*` |

## 3. Data flow: "Find Product Owner jobs in Noida and apply"

1. **Command** (side panel) → `POST /api/tasks` with text. Router (`plan_task`, local first) returns a plan; the plan is **shown before running**.
2. **Search** (server step): job service queries allowed sources → listings stored with source URL → match scores using profile + knowledge base → top N shown with reasons.
3. **User picks** listings → one child task per application.
4. **Open + fill** (browser steps, claimed by the extension): navigate (allowlisted domain) → read page → fill from profile/answers → attach CV (permission per task) → ask missing facts in chat → verify → checkpoint.
5. **Approval**: task stops at `awaiting_approval` before Submit; the user submits on the page (default) or approves a recorded click (opt-in policy).
6. **Follow-up**: recruiter email drafted (Gmail draft via OAuth or DOM insert) → approval → user sends.
7. **Tracking**: application row (`applications`) + task events; notifications on each state change.

## 4. Security boundaries

| Boundary | Rule |
|---|---|
| Page/document text → model | Always quoted as data inside a fixed prompt; model output is schema-validated; free-text outputs pass a **claim check** (no facts outside the supplied set; no contact/ID patterns unless the field asks for them) |
| Model output → browser | The model never emits actions directly. The planner chooses from a typed action list (`open_url`, `read_page`, `fill_fields`, `attach_document`, `insert_text`, `click_next`, `wait_for_user`); each action is validated against policy before the extension runs it |
| Extension ↔ server | Bearer token, no cookies; tokens scoped per device; server re-checks ownership of every task step |
| Server ↔ cloud AI | Consent per purpose, budget per purpose, redaction of identifiers, no document text without per-document consent |
| User data at rest | Existing AES-GCM + RLS; new tables follow the same `asUser` pattern and get RLS tests |
| Never automated | CAPTCHA, OTP, login/password entry, account creation, payments, consent checkboxes |

## 5. Technology choices (and why not others)

- **Keep** Next.js + PostgreSQL + pgvector: already in place, RLS tested; pgvector avoids a second database.
- **Job runner**: Postgres table with `locked_until` leases (as the document worker does) instead of Redis/BullMQ: no new service on a small VPS.
- **Local companion**: Node.js native-messaging host (same language as the codebase), optional install; not required for core features.
- **Playwright**: only inside the companion, only for permitted public pages; not shipped in the extension.
- **No Electron browser** for now (see `AI_BROWSER_DECISIONS.md` D-01).
- **Gmail API** (OAuth) instead of SMTP for user mail: SMTP stays for system mail only.
