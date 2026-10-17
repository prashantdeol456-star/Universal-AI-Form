# Decisions — Personal AI Browser

Each entry: question, options, recommendation, and whether the owner's approval is needed before implementation.

| ID | Question | Options | Recommendation | Approval needed |
|---|---|---|---|---|
| D-01 | Build a dedicated Electron/Chromium browser? | (a) Electron browser; (b) keep Chrome extension; (c) extension + optional local companion | **(c)**. Users keep their Chrome logins and password manager; less to secure and update. Revisit if trusted input events become a hard requirement. | Yes |
| D-02 | Where does task state live? | (a) extension storage; (b) VPS database; (c) both | **(b)**, extension caches only the current step. Survives restarts, visible in the dashboard, auditable. | Yes |
| D-03 | Job sources | (a) automate LinkedIn/Naukri; (b) public ATS boards + current page + user-forwarded alerts + manual URLs; (c) paid job APIs | **(b)** now, (c) later if budget allows. (a) breaks those sites' terms and risks the user's accounts. | Yes |
| D-04 | Who presses Submit / Send? | (a) always the user; (b) app clicks after an approval record; (c) automatic within a policy | **(a) default**, (b) as opt-in per task. (c) not offered for applications or messages. | Yes |
| D-05 | Cloud AI consent granularity | (a) one global switch; (b) per purpose; (c) per purpose + per document | **(c)**. Existing `cloud_ai_enabled` and `ai_profile_sharing` become purposes; documents get their own flag. | Yes |
| D-06 | Local model location | (a) VPS Ollama container; (b) user's PC via companion; (c) both | **(c)**, router decides by availability. A KVM 2 VPS is too small for a 7B model; PC or larger plan needed. | Yes (cost) |
| D-07 | Vector store | (a) pgvector (existing); (b) separate vector DB | **(a)**. Already in the production image; one backup, one RLS model. | No |
| D-08 | Queue technology | (a) Postgres leases; (b) Redis/BullMQ | **(a)**. No new service; matches the document worker. | No |
| D-09 | Trusted input (`chrome.debugger`) | (a) never; (b) per-task opt-in; (c) default | **(b)** only if a key site ignores DOM events; Chrome shows a "being debugged" bar. | Later |
| D-10 | Email integration | (a) DOM insert only; (b) Gmail API OAuth; (c) SMTP as the user | **(a) + (b)**. (c) needs the user's mail password — not acceptable. | Yes (Google OAuth app verification) |
| D-11 | Open answers with weak profiles | (a) write anyway; (b) ask for facts first | **(b)**. Template mode already refuses to write from nothing; extend to AI mode with the claim checker. | No |
| D-12 | Version control and CI | (a) keep as is; (b) git + local CI script; (c) hosted CI | **(b)** immediately (Phase 0), (c) when a remote exists. | Done in Phase 0 (git); CI later |
| D-13 | WhatsApp access method | (a) WhatsApp Business Platform Cloud API; (b) Business app coexistence; (c) chat export / paste; (d) reading WhatsApp Web in the extension; (e) unofficial clients or session cookies | **(c) first** for personal chats; **(a)** for a business number; (b) later; (d) not recommended (terms, fragility) and never in the background or for sending; **(e) rejected**. The Cloud API cannot read a person's own WhatsApp chats. See `AI_BROWSER_WHATSAPP_DESIGN.md` | Yes |
| D-14 | Routing modes | (a) one global switch; (b) `AI_ROUTING_MODE` = `local_only` / `hybrid` / `cloud_enabled` on the server + existing per-user consent | **(b)**, implemented in Phase 0 with default `hybrid` (no behaviour change). A per-user mode in Settings can follow in Phase 1 | No (default keeps current behaviour) |
| D-15 | Comboboxes that open on `focus` when the page is not focused | (a) leave; (b) dispatch `focus`/`focusin` when `document.hasFocus()` is false | **(b)**, in Phase 2 with live-site checks; it changes how every site is filled | Yes |

### Phase 1 decisions (taken, no approval needed — they follow D-02 and D-08)

| ID | Decision | Why |
|---|---|---|
| D-16 | Engine in its own workspace package `@ufa/tasks`, taking the DB pools, step handlers and encryption as parameters | Lets the database tests run the real engine against PostgreSQL with mock handlers; the web app supplies real handlers |
| D-17 | Postgres leases (`FOR UPDATE SKIP LOCKED` + token + expiry) and an in-process runner; no Redis or queue service | Same pattern as the document worker; safe with several containers |
| D-18 | Lease expiry: idempotent steps re-run, others park as `needs_verification` and pause the task | Never repeat a possibly side-effecting action because a worker crashed |
| D-19 | Approvals bound to a payload hash, single use (`consumed_at`), final once decided (DB trigger), 7-day expiry | An approval for one action cannot authorise another, or the same one twice |
| D-20 | Step output with personal text stored encrypted in `task_steps.result_secret`; events carry no content | Drafts and answers are personal data |
| D-21 | Engine errors recognised by `name`/`code` (`taskErrorInfo`) instead of `instanceof` | Next.js dev loaded the package twice and `instanceof` failed (found in the live check) |
| D-22 | Reject on a waiting task → `failed` (retry asks again); reject while paused → `cancelled` | `paused → failed` is not a valid transition |

### Phase 2 decisions (taken, no approval needed — they follow the PROMPT 4 rules)

| ID | Decision | Why |
|---|---|---|
| D-23 | Per-site grants (`site_permissions`, origin + scopes) checked in the panel **and** on the server; Chrome host access requested per origin from the click | Least privilege; a modified extension still cannot get mappings, fill values or documents for a site the user did not allow |
| D-24 | "Allow on all websites" removed | A blanket grant contradicts per-site authorization |
| D-25 | No automated Next / Continue / Submit / payment / message / CAPTCHA / OTP / password / account creation, on any site, ever; these are not grantable scopes (DB check) | The user keeps every irreversible step; multi-page forms continue when the user says they moved on |
| D-26 | Hidden fields are counted, never offered or filled | Hidden inputs are the usual place for injected or honeypot fields |
| D-27 | The page cannot choose actions; injection detection only warns and turns instructed labels into manual fields | Detection can be evaded; the fixed action list cannot |
| D-28 | Fill re-checks the element signature and the form signature/url before typing; verification re-reads every field after | A page that changed after review must not receive the reviewed values |
| D-29 | The review approval is bound to `{origin, pages}`; adding a page expires the pending approval and asks again | An approval for a 1-page fill cannot close a 3-page one |
| D-30 | Documents only via `attach_file` and a per-field choice (panel select, or Attach / Skip in chat); no automatic attach | PROMPT 4: never upload because a page asks |
| D-31 | A pasted URL is shown for review (host + full address) and opened only on "Open"; nothing is filled automatically afterwards | PROMPT 4: no silent automation from a link |
| D-32 | Payment fields (card, CVV, UPI/ATM PIN, `cc-*` autocomplete) are manual like OTP/CAPTCHA | Never enter financial credentials |

### Phase 3 decisions

| ID | Decision | Why |
|---|---|---|
| D-33 | Search uses a blind keyword index (keyed HMAC per user) over encrypted chunks, not PostgreSQL full-text | Full-text would need plaintext in the database; encryption is not weakened for search |
| D-34 | No embeddings / pgvector for personal chunks | Embeddings can leak content, pgvector is optional on the VPS; keyword retrieval is a dependable baseline |
| D-35 | Aadhaar, PAN, caste/EWS/disability certificates, photos and signatures are never indexed | Their few facts are in the profile (masked, confirmed one by one); avoids sensitive categories in search and AI context |
| D-36 | AI answers must cite an excerpt and quote it exactly; anything else is dropped | A model's statement is never evidence on its own |
| D-37 | Cloud AI reads a document only with per-document consent (default off), on top of the global cloud switch; local AI never falls back to cloud | Explicit, revocable consent for sending document text off the server |
| D-38 | Existing extraction review is the "verified facts" layer (no new facts table) | Avoids duplicating the profile system |
| D-39 | Document lifecycle shown as uploaded / processing / ready / failed, mapped from existing statuses; deletion is the existing soft delete plus a DB trigger that purges derived content | No schema churn on a working pipeline |
| D-40 | DOCX is read with an in-repo bounded ZIP reader, no new dependency | Small attack surface; strict size and ratio limits |

### Phase 4 decisions

| ID | Decision | Why |
|---|---|---|
| D-41 | Fetch only documented public APIs (Greenhouse Job Board, Lever Postings); never fetch LinkedIn, Naukri or arbitrary pages server-side — those jobs are added by link with details typed by the user | Terms of use, anti-bot protections, and SSRF risk of fetching user-supplied URLs |
| D-42 | Deterministic, explainable scoring; no embeddings and no AI-generated scores | Testable and reproducible; a model's number is not evidence |
| D-43 | **Match-score methodology**: weights required skills 40, experience 20, education 10, role/title 10, preferred skills 10, location 5, work arrangement 3, employment type 2 (sum 100). Evidence credit: confirmed profile 1.0, found in an uploaded document 0.8, in the profile but not confirmed 0.6, not found 0. Experience: min(1, years/required) × (1 if confirmed else 0.7); unknown → 0 and "needs review". Education: level ≥ required → 1 (0.7 unconfirmed); a missed *preferred* level → 0.5. Title: word overlap with preferred roles, else current designation. Location / arrangement / employment type count only when the user set the preference and the job states it. Factors that do not apply are dropped and the rest rescaled. Provisional when fewer than 3 requirements could be read, no requirement headings, or no required skills | An unspecified preference must never lower a score; every number traceable |
| D-44 | Board refresh runs synchronously on the user's request (one bounded request per board, 10-minute minimum interval) instead of a Phase 1 task or a scheduler | One HTTP call per board needs no queue; no background crawling |
| D-45 | Listings are per user (not a shared catalogue) | RLS stays simple and nobody learns which jobs another user looks at |
| D-46 | "Applied" and later statuses need the user's explicit confirmation (API) and `submitted_confirmed_at` (DB CHECK); form fills are shown as evidence only | Never mark an application submitted because a form was filled |
| D-47 | AI job summaries send only the public job text; each point must quote it | No personal data needed; quotes stop invented requirements |
| D-48 | Feedback has three kinds with different power: votes change nothing; corrections change one job's requirements; ranking rules (user-written or user-approved from a vote) change order only, bounded ±20, never the fit score | Learning stays explicit, explainable and reversible; a prediction never silently becomes a rule or a fact |
| D-49 | Feedback rows can be deleted but not edited; deleting recomputes scores | A clear history; "undo" is always available |
| D-50 | Interview practice questions come from the AI summary and must quote the job requirement they are about | Questions about the job, never assumptions about the candidate |

### Phase 5 decisions

| ID | Decision | Why |
|---|---|---|
| D-51 | Draft-only: Gmail drafts after approval, WhatsApp drafts copied by the user; no send code at all | Sending on someone's behalf is irreversible; the user keeps that step |
| D-52 | Scopes `gmail.readonly` + optional `gmail.compose`; no `gmail.modify`, `gmail.send` or full-mail scope | Least privilege; Google has no drafts-only scope, so compose is asked only when drafts in Gmail are wanted |
| D-53 | Gmail message bodies are fetched on request and never stored; only summaries the user asked for and drafts are kept (encrypted, deletable) | Minimise stored third-party data |
| D-54 | WhatsApp personal chats via user exports only; Business Platform detected but not used; WhatsApp Web, phone databases and unofficial APIs rejected | WhatsApp has no permitted API for personal chats; matches D-13 |
| D-55 | Cloud AI for messages needs both the global switch and per-mailbox / per-chat consent (default off); local first, never silent fallback | Messages contain other people's data |
| D-56 | Recipients come from thread headers only; approval freezes the exact text by hash; creation is a separate non-repeatable step with a recorded draft id | Prevents changed recipients, changed text after approval, and duplicate drafts |
| D-57 | No attachments on Gmail drafts in this phase | Keeps the first version reviewable; attaching documents needs its own per-file approval |
| D-58 | Live verification against a local mock of Google until a real OAuth client is configured; documented as such | No fake claims of a working Google integration |

### Phase 6 decisions

| ID | Decision | Why |
|---|---|---|
| D-59 | Companion = outbound-only Node CLI polling the server over HTTPS; no local HTTP server, no native messaging, no Electron | No inbound attack surface (CSRF, DNS rebinding, other local apps); works behind NAT with the VPS; no new runtime to ship |
| D-60 | Folders are granted only on the computer; the server can view and revoke but never add | A compromised server or account cannot widen local file access |
| D-61 | New devices have no capabilities; only implemented capabilities can be granted (DB CHECK, schema, policy) | Default deny; no switch for features that do not exist |
| D-62 | Commands are fixed templates (program + args), no shell, minimal env, timeout, output cap; npm runs through Node's `npm-cli.js` on Windows | No command injection; the device token never reaches child processes |
| D-63 | Moves never delete or overwrite (hard link + unlink), are logged for undo and verified; reports use exclusive create | Reversible file changes only in this phase |
| D-64 | Every side effect has its own approval bound by hash (plan SHA, file name, command id); the companion re-checks that the approval matches before acting | What runs is exactly what was shown |
| D-65 | Emergency stop pauses tasks and blocks claims; clearing it never resumes anything | No unsafe auto-resume |
| D-66 | Screen, window and input control deferred (declared, disabled, refused) | Not safely testable yet; no covert monitoring |
| D-67 | Learning = saved workflows (draft until approved), confirmed preferences, stored feedback; never model training; never fewer approvals | Transparent, editable memory; the user stays in control |
| D-68 | File text leaves the computer only as the summary the user asked for; excerpts to AI only with per-device consent (cloud needs a second consent) | Local files are the most private data the app touches |

### Phase 8 decisions

| ID | Decision | Why |
|---|---|---|
| D-69 | Remote control = the existing dashboard + outbound companion; no port forwarding, tunnel or remote-desktop protocol | Works from any phone browser without exposing the computer |
| D-70 | Automatic start is visible (Windows: titled minimised window; Linux: named systemd user unit) and never elevated | Always-on must not become covert or privileged |
| D-71 | Agents are roles over normal tasks; a mission adds ordering and review, never permissions | One policy engine and one approval path for everything |
| D-72 | Planning a mission creates nothing; starting re-checks every step's permissions | Permissions may change between planning and starting |
| D-73 | A failed or cancelled step pauses the mission; retry / skip are explicit user actions (≤ 5 attempts) | No blind retries of possibly half-done work |
| D-74 | The Reviewer agent sees only result metadata; cloud only if every involved computer allows cloud AI | A summary across computers must not leak one computer's data under another's consent |
| D-75 | Mission parts are fixed after planning (DB grants allow only progress columns) | What runs is what the user saw in the plan |

## Personal WhatsApp vs WhatsApp Business

- **Personal WhatsApp** (the regular app): no official API gives a third-party app access to its chats. Supported,
  user-controlled routes are chat export and copy/share. Automating WhatsApp Web or using unofficial clients is
  against WhatsApp's terms and can get the number banned.
- **WhatsApp Business app**: can be connected to the Cloud API through Embedded Signup ("coexistence"), keeping
  one-to-one use in the app and syncing history if the business permits.
- **WhatsApp Business Platform (Cloud API)**: a business phone number receives messages by webhook and sends
  through the API; free-form replies only within 24 hours of the user's last message, template messages outside.

## Assumptions

- One owner plus a small number of users at first; the VPS stays a single web container (in-memory rate limits acceptable until then).
- Users run Chrome or a Chromium browser that supports MV3 side panels (Chrome 116+).
- Gemini remains the cloud provider; other providers can be added behind the router later.
- Job applications are submitted by the user on the employer's site; the app does not act on job boards that forbid automation.

## Out of scope (confirmed by existing PRD)

CAPTCHA solving, OTP handling, creating website accounts, storing website passwords, payments, and any action that
circumvents a site's access controls.
