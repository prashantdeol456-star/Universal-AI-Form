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
