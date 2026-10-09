# Learning (implemented — phase 9)

The assistant learns **which website field is which profile field** — never values. Code:
`packages/ai/src/learning` (decisions, form-change diff, the promotion job) and `apps/web/src/server/learning`
(hooks, scheduler, user-facing functions).

## What creates learning

| Event | Effect |
|---|---|
| ✓ Correct / ✗ Change in the side panel | The user's own `USER` mapping (domain + field signature) is verified / the wrong one gets a failure; a `learning_examples` row: `USER_VERIFIED`, `GEMINI_USER_VERIFIED`, `LOCAL_AI_USER_VERIFIED` or `USER_CORRECTION` (+ `learning_corrections`) |
| A field was filled after the user confirmed the preview | Their `USER` mapping becomes verified (+1 success, `verification_source = application`) and a `SUCCESSFUL_APPLICATION` example is written |
| Unconfirmed AI predictions | Nothing. Only people create learning |

Examples store **structure only**: label, normalised label, field signature, section, input type, up to 20 option
labels, language, domain, target key. `contributor_user_id` is kept (never exported to datasets) so contributions can be
withdrawn. Duplicates (same user, site, label, key, source) within 30 days are skipped.

## Three layers of knowledge (`form_mappings.scope`)

| Layer | Created by | Rule |
|---|---|---|
| `USER` | the user's own actions | used for that user immediately (exact field on that site; same label on other sites weighs less) |
| `WEBSITE` | the learning job | ≥ `LEARNING_WEBSITE_MIN_USERS` (default 2, min 2) **different** users agree on that site's field, agreement ≥ 80 % |
| `GLOBAL` | the learning job | ≥ `LEARNING_GLOBAL_MIN_USERS` (default 3, min 3) users on ≥ 2 websites, agreement ≥ 90 %, and a specific label (not "Name", "Date", "No."; no digit runs or e-mail-like text; never "not a profile field") |

"Agreement" counts distinct people: one user confirming ten times is one vote; a user who marked a mapping wrong counts
against it. The job (`runLearning`) runs every `LEARNING_INTERVAL_MINUTES` (default 30) and about a minute after new
evidence, holds a transaction-scoped advisory lock (one run at a time across processes), upserts shared rows with
`verification_source = 'learning'` and **demotes** (verified = false, `learning_demoted`) shared rows whose evidence no
longer holds — users disagreed, forgot a mapping, opted out or were deleted. Admin-verified rows are never touched.
Each run is logged in `learning_runs` (server-only).

Shared rows contain no user id. The runtime database role cannot write `WEBSITE`/`GLOBAL` rows at all (RLS); only the
server's job can.

## Form change detection

Each version of a page (`form_signatures`, one per set of visible field signatures) stores **all** its field signatures.
When the current version first appeared **after** the user's last application on that URL, the side panel says
"This form changed since you applied … N new fields / M removed", and site-specific knowledge (`WEBSITE`, `USER` for that
field) is weighed ×0.85, so more fields ask for review. Fields that only appear dynamically (District after State) were
seen in earlier versions and do not count as new.

## User control (Dashboard → Learning)

- See every learned mapping, search it, **Forget** one (asked again next time).
- **Help improve matching for everyone** (default on): off = no new examples and the user's mappings no longer count
  towards shared knowledge (shared rows relying on them are demoted on the next run).
- **Withdraw all my contributions**: turns sharing off and marks all their examples `REMOVED` (excluded from every
  future dataset). Audited.
- The data export includes learned mappings and contributed examples.

No retraining per request: examples accumulate → admin review (phase 12) → datasets (phase 11, see ML_TRAINING.md).
