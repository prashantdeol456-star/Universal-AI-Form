# WhatsApp Intelligence Agent — integration design (future phase, not implemented)

Status: **design only**. No code reads or sends WhatsApp messages. The router reserves the purposes
`understand_whatsapp` and `draft_whatsapp_reply` (`packages/ai/src/router.ts`), and they refuse to run until an
implementation and tests exist.

Facts below were checked against Meta's developer documentation on 14 October 2026 (pages "About the WhatsApp
Business Platform", "Service messages" and "Onboard WhatsApp Business app users"). Re-check them before building:
Meta changes this platform often.

## 1. What the agent should do (when built)

- Read messages only through an explicitly authorised channel, and only the chats the user selects.
- Summarise unread or selected chats; flag messages that need a reply.
- Draft replies from the user's approved profile, documents and the conversation, matching its tone and language
  (English, Hindi, Hinglish).
- Show the source messages next to the draft; the user edits, approves, rejects or regenerates.
- Track status (draft → approved → sent / failed) with an idempotency key so a message is never sent twice.
- Per-chat permissions, retention limits and audit logging; no access to unrelated chats.

## 2. Access options

| Option | What it can access | Fits a personal WhatsApp account? | Verdict |
|---|---|---|---|
| **WhatsApp Business Platform — Cloud API** (Meta) | Messages sent **to a registered business phone number**, delivered to our server by webhook; sending from that number | **No.** It does not give access to a person's own WhatsApp chats | Supported path for a business number (e.g. a café or an agency number) |
| **Cloud API + WhatsApp Business app "coexistence"** (Embedded Signup) | A number already used in the **WhatsApp Business app** can also be used through the API; message history can sync if the business permits | Only for WhatsApp **Business app** users, not the regular WhatsApp app | Possible later for users who run their work on the Business app; needs Meta Tech Provider setup and Embedded Signup v4 (v2/v3 are deprecated on 15 Oct 2026) |
| **Chat export** (WhatsApp → chat → Export chat → `.txt`) | One chat the user chooses to export | Yes, user-controlled | **Recommended first step for personal chats**: upload the export like a document; nothing is accessed without the user acting |
| **Copy / share text** (copy messages, or the phone's share sheet into our web app) | Only what the user pastes or shares | Yes, user-controlled | Recommended for one-off replies |
| **Reading WhatsApp Web in the browser** (extension content script on `web.whatsapp.com`) | The open chat on screen | Technically yes | **Not recommended.** WhatsApp's terms do not allow automated or unauthorised access; DOM structure changes often; risk to the user's account. At most: read the visible chat **once, on an explicit click**, never in the background, never sending |
| Unofficial libraries / session-cookie reuse / headless WhatsApp Web | Whole account | — | **Rejected.** Against WhatsApp's terms, can get the number banned, exposes the full account |

## 3. Recommended design

**Stage 1 — personal chats, user-controlled (no WhatsApp integration at all).**
Upload a chat export or paste text → `understand_whatsapp` summarises and lists messages needing replies →
`draft_whatsapp_reply` drafts → the user copies the reply into WhatsApp and sends it themselves.

**Stage 2 — business number via Cloud API (opt-in, for users with a business number).**
Webhook endpoint on the VPS receives messages for the connected number only → stored encrypted per user →
drafts as in Stage 1 → **send only after an approval record**, inside the 24-hour customer-service window
(outside it only approved template messages can be sent) → delivery status from webhooks updates the message.

**Stage 3 (optional) — coexistence** for WhatsApp Business app users, after Stage 2 is stable.

## 4. Data, permissions and privacy

| Topic | Rule |
|---|---|
| Scope | Per-chat allowlist; messages from other chats are ignored and not stored |
| Storage | Message text encrypted at rest (existing AES-GCM); default retention 30 days, user-configurable; deleted with the account (`eraseUser`) |
| Cloud AI | Message text goes to Gemini only with a per-chat consent flag; otherwise local model or no AI |
| Third parties' data | Messages contain other people's personal data: minimise, never use them for shared learning or training |
| Sending | Never automatic by default; approval record per message; idempotency key; no bulk or unsolicited messages |
| Tokens | Meta access tokens stored encrypted on the server, never in the extension; revoke button |
| Prompt injection | Message text is quoted data; a message cannot trigger actions, change recipients or send anything |
| Audit | Read, draft, approve, send and delete events logged without message text |

## 5. Database (proposed, for the implementation phase — not created now)

`whatsapp_connections` (user, channel type, encrypted token, number id, status), `whatsapp_chats` (user, external
chat id hash, display name, allowed, retention), `whatsapp_messages` (chat, direction, encrypted text, received_at,
expires_at), `whatsapp_drafts` (message, encrypted draft, status, approval id, idempotency key). All with RLS
(owner only) and DB tests.

## 6. Open questions for the owner

1. Is Stage 1 (export / paste, no integration) enough for the personal use case?
2. Is there a business number that should use the Cloud API, and who owns the Meta Business account?
3. Default retention for stored messages (30 days proposed)?
