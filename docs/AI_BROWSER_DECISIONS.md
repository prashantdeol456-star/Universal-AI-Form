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
