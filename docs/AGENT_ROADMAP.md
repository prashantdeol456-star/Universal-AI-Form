# Personal AI Browser Agent — gap analysis and plan

Maps the "Personal AI Browser Automation Extension" spec onto this repository. Most of the foundation already exists
(phases 1–13); the missing parts are the **agent loop** (plan → act → verify → ask), richer knowledge (free-text
document retrieval, approved answers) and the controls around it.

## What already exists

| Spec area | Status in this repo |
|---|---|
| MV3 extension, side panel, sign-in, settings | ✅ `apps/extension` |
| Persistent account, encrypted storage, export/delete | ✅ PostgreSQL + RLS, AES-GCM, Privacy page, account deletion |
| Document upload PDF / images + OCR (EN+HI), extraction with review | ✅ — DOCX/TXT/CSV/XLSX **missing** |
| CV → profile (name, contact, LinkedIn, skills, summary, current job, education) | ✅ (rules; reviewed by the user) |
| Form detection (labels, ARIA, custom dropdowns, shadow DOM, iframes, SPAs) | ✅ `packages/form-engine` |
| Field matching (rules → knowledge base → fuzzy → embeddings → local AI → Gemini) | ✅ `packages/ai/src/mapping` |
| Fill text / select / radio / checkbox, undo, validation reasons | ✅ |
| Attach documents to upload fields (e.g. Workday "Autofill with Resume") | ✅ new |
| Gmail/Outlook draft writing + insert | ✅ new (`Write email` tab) — sending, attachments in Gmail **missing** |
| Local model (Ollama) + Gemini, provider interface, budgets, opt-out | ✅ — Claude / OpenAI-compatible adapters **missing**; per-user mode choice **missing** |
| Learning: corrections, per-site mappings, promotion, change detection | ✅ |
| pgvector, ML pipeline, admin, audit, 2FA, monitoring | ✅ |

## Gaps (what will be built)

**A. Agent core (MVP of the new spec)**
1. Task chat in the side panel: instruction → structured plan (steps with Pending / In progress / Needs input / Awaiting approval / Done / Failed).
2. Executor that runs steps with the existing engines (analyze, map, fill, attach, write answer) and **verifies after each action**; real activity log; Start / Pause / Resume / Stop.
3. Visible actions in the page: an overlay cursor that moves to the real element, click ripple, field highlight, typed-text effect — driven by the actual DOM actions, never a fake animation.
4. Open-ended questions ("Why are you suitable…", "Describe your AI experience"): answer drafted from the CV text + profile + **approved answers**, with word limits; unknown facts → asked in chat; answer saved after approval.
5. Approved-answers memory (question → answer, reuse only when the meaning matches) with review/edit/delete.
6. Approval gates: clicking Next / Save and Continue is allowed when the user enables it for the task; **Submit / Send / Pay / Delete always need an explicit click on Approve** in the panel. CAPTCHA / OTP / login → pause and ask.
7. Prompt-injection guard: page text is passed to models only as quoted data; tool calls are limited to a fixed action set.

Status — first slice of A done: “Fill everything” with visible cursor and typing, chat that learns facts, saved
answers, open-question drafting with consent, CV/photo auto-attach, Stop. Still open in A: pause/resume mid-run,
multi-page “Next” navigation, task history view.

**B. Reliable automation**: multi-page workflows (Next → wait → re-analyze), validation-error detection and recovery, saved website strategies, task history, feedback buttons (correct / partly / wrong) feeding the learning engine, Gmail attachment + send after approval with duplicate-send protection.

**C. Advanced**: DOCX/TXT/CSV/XLSX upload, full-text chunk retrieval with pgvector, Claude and OpenAI-compatible providers with a Local / Cloud / Hybrid / cost-conscious selector, optional desktop companion for OS-level mouse/keyboard, evaluation dashboard.

## Chrome extension limits (honest list)

- Content scripts act through the DOM (`click()`, input events). Pages see these as script events (`isTrusted = false`); most sites accept them, a few ignore untrusted events. The cursor overlay shows where the action happens; it is not the OS mouse.
- Real OS mouse/keyboard (trusted events) needs either the `chrome.debugger` API (shows a "being debugged" bar) or a separate local companion app — planned as optional (phase C).
- Native file pickers cannot be opened by scripts; files are attached by setting the `<input type=file>` (works on Workday and most sites).
- Pages in other extensions, the Chrome Web Store and `chrome://` pages cannot be automated. Cross-origin iframes need site permission.
- The side panel stays open while the agent works; closing it stops the task (by design: no hidden background agent).

## Running cost (self-hosted)

Hostinger KVM 2 (~₹600–800/month) runs PostgreSQL, the web app and the worker. Gemini Flash costs a few paise per form;
budgets are enforced per user per day. A local model (Ollama, 7B) needs a KVM 8 or a separate PC with ≥16 GB RAM.
