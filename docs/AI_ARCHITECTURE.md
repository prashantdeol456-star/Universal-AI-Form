# AI architecture

> Status: chat (phase 3), document extraction (phase 2), the form-field mapping/confidence/decision engines (phase 5) and
> the Gemini fallback + `AIOrchestrator` (phase 6) are implemented.

## Chat assistant (implemented, phase 3)

```
message → language (en / hi / hinglish) → rule-based fact extraction (packages/ai/src/chat/facts.ts)
        → intent: UPDATE | QUERY | SUMMARY | HELP | UNKNOWN
        → UNKNOWN + LOCAL_AI_ENABLED → local model (schema-constrained, value must appear in the message, confidence ≤ 0.8)
UPDATE  → per fact: NEW / UPDATE (stored value differs → "I currently have X… update to Y?") / SAME
        → proposals; nothing is saved until the user clicks Save / Yes, update
QUERY   → answered from the stored profile ("memory"); SUMMARY lists what is saved
```

Replies are **templated**, not generated: the assistant can never state a fact that is not in the profile. Gemini is not
used for chat. Sensitive identifiers are masked in stored chat text; proposal values are encrypted. Local-AI calls are
logged in `ai_requests` (no message content).

## Form-field mapping (implemented, phase 5) — `packages/ai/src/mapping`

| Stage | What it does | Evidence weight |
|---|---|---|
| Autocomplete | HTML `autocomplete` tokens (`name`, `bday`, `postal-code`, …) | 0.85 |
| Lexicon | Label → language-independent concepts (EN, हिंदी, Hinglish; phrases first), then concept rules; a bare "Name" uses the section heading; education level from label, else section | 0.6–0.94 per rule, +0.5 when every word of the label is understood |
| Knowledge base | `form_mappings`: this website's field → your confirmed mapping → your mapping on other sites → verified global pattern | 0.8–0.95 × smoothed success rate; repeated failures turn negative |
| Fuzzy | Character-trigram similarity to reference phrasings of every field | ≤ 0.8 |
| Semantic | Embedding similarity (Ollama `LOCAL_AI_EMBED_MODEL`): in-process catalog phrases + shared learned labels in pgvector when available (phase 11) | ≤ 0.6 |
| Local AI | `LocalAIProvider.mapFields` for fields still below review; may answer "none" | capped at 0.8, × 0.8 ⇒ ≤ 0.64: a model alone can only suggest |
| Context | "you have this value" (tie-breaker for rule-backed candidates), "matches your highest qualification" | 0.15 / 0.4 |
| Penalties | Type mismatch (a name into a date picker, email input, single checkbox) | −0.4 … −0.6 |

Confidence = noisy-OR of positive evidence × penalties. Decision (`engine.ts`, the only place):

| Decision | When |
|---|---|
| `MANUAL` | CAPTCHA, OTP, password, file upload, declaration checkbox, "not a profile field" feedback |
| `GEMINI` | below `AI_FALLBACK_THRESHOLD` and Gemini is enabled but was skipped this time (daily budget reached) — shown to the user as "ask me" |
| `ASK_USER` | best confidence < `AI_FALLBACK_THRESHOLD` (0.70) after every stage incl. Gemini, or the profile has no value |
| `USER_REVIEW` | the only evidence is a Gemini answer (`ai_suggestion`), ambiguous label (unless you already confirmed it), close runner-up, option not matchable, sensitive field, unverified value, or confidence below `AI_CONFIDENCE_THRESHOLD` (0.90) |
| `AUTO_FILL` | confidence ≥ 0.90, verified value, not sensitive, option matched |

Benchmark: `packages/ai/src/mapping/benchmark.json` (105 labels, EN/HI/Hinglish, incl. non-profile traps) runs in `npm test`
and fails the build below 93 % accuracy or above 2 % wrong mappings. Current: 100 % / 0 %. **Caveat:** the benchmark was
written together with the rules, so it guards against regressions rather than proving real-world accuracy. Real accuracy
will come from user feedback (`learning_corrections`) and the phase 11 evaluation set.

## Gemini fallback (implemented, phase 6) — `packages/ai/src/providers/gemini.ts`, `orchestrator.ts`

```
fields still < AI_FALLBACK_THRESHOLD after rules → KB → fuzzy → semantic → local AI
  → user opted out (Settings → AI assistance)?          → stop (ASK_USER)
  → answer cache (ai_mapping_cache, key = normalised label | section | type | options; no user data) → reuse
  → daily budget: min(GEMINI_MAX_FIELDS_PER_REQUEST, GEMINI_DAILY_FIELD_LIMIT − fields sent today)
  → POST {GEMINI_BASE_URL}/models/{GEMINI_MODEL}:generateContent   (header x-goog-api-key, server only)
        prompt: field_id, label, section, type, options — nothing else
        response schema: {mappings: [{field_id, profile_field ∈ catalog keys ∪ "none", confidence}]}
  → zod validation; unknown keys/ids dropped; confidence capped 0.85, weight × 0.95 ⇒ ≤ 0.81
  → a field backed only by Gemini is always USER_REVIEW (reason ai_suggestion), never AUTO_FILL
```

- One retry on 429/5xx; any failure → status `failed`, the fields fall back to `ASK_USER`, the rest of the form is unaffected.
- `ai_requests` (one row per call: model, latency, tokens, item count, success/error code), `ai_field_suggestions`
  (field signature + suggested key, later `user_confirmed / user_corrected / final_key` from the side panel ✓/✗),
  `ai_usage` (daily totals). No labels' values, profile data or prompts are stored.
- The side panel shows whether Gemini was used, cached, off, or over the daily limit.
- Default model `gemini-3.5-flash`; any model supporting structured JSON output works via `GEMINI_MODEL`.

## Email drafting — `packages/ai/src/compose`, `apps/web/src/server/compose`

Same rule as mapping: the model never sees profile values. Gemini receives the user's request (Aadhaar/PAN/account
numbers, e-mails and phone numbers masked with `redact`) and the **names** of the everyday profile details the user has
(`EMAIL_PLACEHOLDER_KEYS`: personal names/DOB/nationality, contact, education, employment except salary/employee ID). It
returns `{subject, body}` with `{{key}}` placeholders (JSON schema, re-validated, markup stripped); `renderDraft` fills
them server-side, shows missing ones as `[Label]` and drops anything not allowed. Refinements send back the placeholder
template, not the rendered text. `templateDraft` (job application, follow-up, leave, thanks; EN/HI) is the no-AI path.
Counts go to `ai_requests` (`operation = 'compose_email'`) and `ai_usage`; drafts are not stored.

## Decision engine — one place, not scattered

```
FieldRequest {label, name, id, type, section, options, required, nearbyText, lang, domain, formSignature}
  1. Deterministic rules      exact/alias match on catalog aliases (EN/HI/Hinglish), input type, autocomplete attr
  2. Knowledge base           verified WEBSITE mapping → verified GLOBAL mapping → USER mapping   (form_mappings)
  3. Semantic search          pgvector similarity over verified labels
  4. Local AI                 LocalAIProvider (Ollama / llama.cpp; model from LOCAL_AI_MODEL)
  5. Confidence engine        independent score (below)
  6. Decision                 AUTO_FILL ≥ AI_CONFIDENCE_THRESHOLD (0.90)
                              USER_REVIEW ≥ AI_FALLBACK_THRESHOLD (0.70)
                              GEMINI below that (if GEMINI_ENABLED), else ASK_USER
                              MANUAL for CAPTCHA/OTP/unsupported controls
```

`packages/ai` will expose:

```ts
interface AIProvider {
  analyzeForm(input): Promise<FormAnalysis>;
  mapField(input): Promise<MappingResult>;         // { profile_field | null, confidence, rationale? }
  extractDocument(input): Promise<ExtractedField[]>;
  classifyField(input): Promise<FieldClass>;
  answerQuestion(input): Promise<Answer>;
  extractProfileData(input): Promise<ProfileFact[]>; // chat: "My father's name is Raj Kumar"
  resolveAmbiguity(input): Promise<Resolution>;
}
// LocalAIProvider, GeminiProvider, MockLocalAIProvider, MockGeminiProvider; AIOrchestrator composes them.
```

## Confidence engine

Model self-reported confidence is one input, never the decision. Weighted features: exact/alias match, semantic
similarity, verified website mapping (+ success/failure counts), global mapping, user history, profile evidence (value
exists and is verified), document evidence, agreement between rules / local / Gemini, form-signature drift penalty.
Weights are configuration; calibration is measured in phase 11 (reliability diagrams on the benchmark set).

## Abstention

Every provider may return `profile_field: null` ("I don't know"). Wrong filling is worse than a blank field.

## Safety

- AI returns JSON validated against a zod schema; anything else is discarded.
- AI output is never executed; the extension's deterministic filler sets values.
- Gemini keys live only on the server; the extension talks to the backend only.
- Minimal context to Gemini: field label, section, type, options, and candidate profile **keys** — not profile values or documents.
- `ai_requests` stores provider, model, operation, latency, success, confidence, decision, fallback, user_confirmed/corrected, token counts — never prompt contents or personal values.
- Gemini outage → rules + knowledge base + local AI + manual input continue to work.
