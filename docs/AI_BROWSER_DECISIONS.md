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
| D-12 | Version control and CI | (a) keep as is; (b) git + local CI script; (c) hosted CI | **(b)** immediately (Phase 0), (c) when a remote exists. | Yes |

## Assumptions

- One owner plus a small number of users at first; the VPS stays a single web container (in-memory rate limits acceptable until then).
- Users run Chrome or a Chromium browser that supports MV3 side panels (Chrome 116+).
- Gemini remains the cloud provider; other providers can be added behind the router later.
- Job applications are submitted by the user on the employer's site; the app does not act on job boards that forbid automation.

## Out of scope (confirmed by existing PRD)

CAPTCHA solving, OTP handling, creating website accounts, storing website passwords, payments, and any action that
circumvents a site's access controls.
