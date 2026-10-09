# Architecture

## System overview

```
 Chrome extension (MV3, phase 4)          Browser (dashboard)
   side panel · content scripts              Next.js React UI
        │  Bearer token                          │  httpOnly session cookie
        └──────────────────┬─────────────────────┘
                           ▼
              apps/web — Next.js route handlers (REST /api/*)
              ├─ server/auth      sessions, signup/login, OTP, reset
              ├─ server/profile   profile service (validate → encrypt → decide → history → audit)
              ├─ server/http      CSRF origin check, rate limits, uniform errors
              ├─ (phase 2+) documents, chat, forms, AI orchestrator, learning
              │
              ├── system pool  (owner role)   auth lookups, migrations, background jobs
              └── app pool     (ufa_app role) every user-scoped query, inside withUser() ──► RLS
                           ▼
              PostgreSQL 16 (+pgvector)          Local disk volume (documents)
                           ▲
              AI providers (phase 5–6): rules → knowledge base → semantic search → Local AI (Ollama/llama.cpp) → Gemini
```

## Key decisions

| Decision | Choice | Why |
|---|---|---|
| Hosting | Single VPS, Docker Compose, Caddy | User requirement (Hostinger VPS). Cheap, predictable, full data control. |
| Database | Self-hosted PostgreSQL 16 | Replaces Supabase. Same RLS model, no vendor lock-in. |
| Auth | Built in (scrypt + opaque DB sessions) | Replaces Supabase Auth. Revocable sessions, works for cookies (web) and bearer tokens (extension). OAuth providers can be added as another credential type later. |
| Data access | `postgres` (porsager) with tagged SQL; SQL-file migrations | RLS policies and constraints are SQL anyway; no ORM layer to fight. |
| API location | Next.js route handlers in `apps/web` (no separate `apps/api`) | One deployable unit. **Deviation from the original plan, documented.** The services in `server/` are framework-agnostic and can move to a standalone API later. |
| Packages | `shared` merges the planned `types` + `validation` packages | Avoids three tiny packages that always change together. |
| Monorepo tool | npm workspaces | No extra tooling on the VPS. |
| Encryption | App-level AES-256-GCM for sensitive fields | Database dumps alone do not reveal Aadhaar/PAN/bank data. |

## Request lifecycle (user-scoped)

1. `route()` wrapper: CSRF origin check for cookie-authenticated mutations, error mapping (zod → 422, HttpError → status, unknown → 500 with redacted log).
2. `requireUser(permission)`: session lookup by SHA-256 of the token; role permission check (RBAC).
3. Service runs `asUser(user, tx => …)`: a transaction on the `ufa_app` pool with `app.user_id` / `app.user_role` set; PostgreSQL RLS enforces tenant isolation **independently** of application code.
4. Mutations write history + audit rows in the same transaction.

## AI safety boundary (applies from phase 4)

AI never controls the browser. Providers return structured JSON (`{ profile_field, value, confidence }`) validated with zod; deterministic extension code performs filling. LLM output is never executed.
