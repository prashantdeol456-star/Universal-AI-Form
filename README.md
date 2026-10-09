# Universal AI Form Assistant

A self-hosted, self-learning form intelligence platform: one verified personal profile, a Chrome extension that understands
online forms (government jobs, admissions, scholarships, exams, onboarding…), a careful hybrid AI (rules → knowledge base →
local model → Gemini fallback), and a cyber-café mode where customers stay in control of their data.

Runs entirely on **one VPS** (Hostinger or any Ubuntu server) with Docker — no Supabase, no Vercel.

## Status

| Phase | Scope | Status |
|---|---|---|
| 1 | Monorepo, shared types, PostgreSQL schema + RLS, auth, profile engine, customer dashboard, VPS deployment | **Done** |
| 2 | Document upload, encrypted storage, antivirus hook, OCR (EN+HI), extraction, review, conflict resolution | **Done** |
| 3 | AI chat (EN/HI/Hinglish), confirm-before-save proposals, conflict prompts, memory recall | **Done** |
| 4 | Chrome extension (MV3 side panel, sign-in, on-demand page access), form detection & normalization (EN/HI, dynamic/SPA, shadow DOM, iframes), test-form site | **Done** |
| 5 | Mapping engine (multilingual lexicon, section context, fuzzy, knowledge base, embeddings, local AI), independent confidence engine, decision engine, AIProvider + LocalAIProvider (Ollama) + mocks, side-panel feedback, labelled benchmark | **Done** |
| 6 | Gemini fallback (server-side only, minimal context, structured JSON, cache, daily budget, per-user opt-out), `AIOrchestrator`, AI telemetry + per-user usage on the Privacy page | **Done** |
| 7 | Form filling: choose fields, preview, explicit confirmation, deterministic filler (native + custom controls, shadow DOM, iframes), value validation, undo, immutable encrypted application snapshot, "I submitted it", applications list | **Done** |
| 8 | Application history (search, filters, CSV), application details (snapshot, audited reveal, timeline), document links, saved forms (dashboard + extension), "you applied here before" in the extension; refreshed dashboard and side-panel UI | **Done** |
| 9 | Learning engine: structure-only examples from ✓/✗ and successful fills, WEBSITE/GLOBAL knowledge only when several different users agree (auto-demotion), form change detection, Learning page (forget, opt-out, withdraw) | **Done** |
| 10 | Cyber café mode: café registration, operator invites, customer one-time codes and access requests (approve/untick/stop), café bar in the extension (fill for a customer within granted categories), session state machine (≤ 12 h, never extended), values hidden from the café after the session, customer café log + notifications, owner reports | **Done** |
| 11 | ML pipeline: consensus-based, PII-checked, leakage-free datasets in the exact inference prompt; LoRA/QLoRA training + GGUF export (Python, GPU box); one evaluation for rules/Ollama/fine-tuned models; model registry with promotion gate and rollback (never auto-deploys); optional pgvector label search in the same PostgreSQL | **Done** |
| 12 | Admin dashboard: platform overview (users, cafés, forms, AI usage, learning, model), users (suspend/reactivate/sign out/role, counts only), cafés (suspend), learning review (approve/reject by label → field, shared patterns on/off), model registry UI (same gate as CLI), audit log; admin code is source-checked never to read personal values | **Done** |
| 13 | Hardening: two-step verification (TOTP, required for admins), account deletion with grace period + full purge, in-app notifications (new device, café, documents, deletion), Prometheus metrics + deep health check, extra security headers, DB timeouts, load test script, dependency audit clean, [security review](docs/SECURITY_REVIEW.md) | **Done** |

See [docs/ROADMAP.md](docs/ROADMAP.md). Unbuilt dashboard sections are labelled with their phase and have no fake buttons.

## Quick start (local development, Windows/macOS/Linux)

Requirements: Node.js ≥ 20.11 (22 recommended). Docker is optional.

```bash
npm install
cp .env.example .env        # then: npm run gen:secrets and paste values (see .env.example comments)
npm run dev:db              # PostgreSQL 16 without Docker (keeps running; use a second terminal)
npm run db:migrate
npm run dev                 # http://localhost:3000
```

With Docker instead of `dev:db`: `npm run dev:services` (PostgreSQL + Mailpit email UI on http://localhost:8025).

Without SMTP configured, verification codes and reset links are printed in the `npm run dev` console.

## Checks

```bash
npm run typecheck
npm run lint
npm test          # unit tests
npm run test:db   # migrations + RLS integration tests on a throwaway PostgreSQL 16
npm run build
```

## Layout

```
apps/web               Next.js app: dashboard UI + REST API (route handlers) + server services
apps/extension         Chrome extension (MV3, side panel) — build: npm run build:extension
apps/test-form         Local test website (government-style form, Hindi labels, dynamic fields, SPA) — npm run test-form
packages/shared        Types, roles/permissions, profile field catalog (EN/HI), validators, zod schemas
packages/security      Password hashing, tokens, AES-256-GCM field encryption, rate limiting, log redaction
packages/profile-engine  Provenance-aware update decisions, completion scoring
packages/storage       Storage interface, local-disk driver, at-rest encryption wrapper
packages/document-engine  File validation, ClamAV client, OCR (Tesseract/pdf.js), rule + local-AI extraction
packages/ai            Chat understanding (rule-based EN/HI/Hinglish facts, intents, replies, optional local AI); AI providers from phase 5
packages/form-engine   Form detection/normalization (DOM), snapshot schema, signatures
packages/db            PostgreSQL client, RLS user context, migration runner + CLI
database/migrations    SQL migrations (schema, RLS policies, grants)
database/tests         RLS / migration integration tests
docker/, Dockerfile, docker-compose*.yml   Deployment
ml/                    Training pipeline (phase 11)
docs/                  Architecture, database, API, security, deployment, …
```

## Documentation

[Architecture](docs/ARCHITECTURE.md) · [Documents](docs/DOCUMENTS.md) · [Database](docs/DATABASE.md) · [API](docs/API.md) · [Security](docs/SECURITY.md) ·
[Deployment (Hostinger VPS)](docs/DEPLOYMENT.md) · [Testing](docs/TESTING.md) · [Privacy](docs/PRIVACY.md) ·
[AI architecture](docs/AI_ARCHITECTURE.md) · [Learning](docs/LEARNING.md) · [ML training](docs/ML_TRAINING.md) ·
[Extension](docs/EXTENSION.md) · [Café mode](docs/CAFE_MODE.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [Roadmap](docs/ROADMAP.md)
