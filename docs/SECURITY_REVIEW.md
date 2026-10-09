# Security review (phase 13)

Internal review of the whole system before the first VPS deployment. It is a checklist plus what was found and changed,
not a third-party penetration test — book one before handling real users at scale.

## Checklist

| Area | Check | Result |
|---|---|---|
| Authentication | scrypt passwords, opaque DB sessions, login rate limits, generic errors | ✅ |
| | Two-step verification (TOTP, RFC 6238) with one-time recovery codes; secret encrypted, codes hashed, unreadable by the runtime role | ✅ new |
| | Admin permissions (`admin:*`) refused without 2FA (`ADMIN_REQUIRE_MFA`, default on) — API returns 403, pages redirect to Settings | ✅ new |
| | MFA challenge: 5-minute single-use token, 5 attempts, rate-limited per IP | ✅ new |
| | New-device sign-in creates an in-app notification | ✅ new |
| Authorization | RLS on every user table; runtime role is not the owner; admin services re-check permissions first | ✅ |
| | Source-level test fails the build if admin code reads personal data | ✅ |
| Data protection | AES-256-GCM for sensitive values, snapshots and files; masked UI; audited reveal | ✅ |
| | No Aadhaar/PAN/password/OTP/bank values in logs — mailer, purge job, metrics and audit write ids/hashes only | ✅ reviewed |
| | Right to erasure: scheduled deletion, grace period, full purge incl. files; audit rows kept without the person link | ✅ new |
| Web | CSP, HSTS (via Caddy), X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy (camera, mic, geolocation, payment, usb off) | ✅ |
| | Cross-Origin-Opener-Policy `same-origin`, Cross-Origin-Resource-Policy `same-origin` for pages, X-Permitted-Cross-Domain-Policies `none` | ✅ new |
| | CSRF: Origin check on cookie requests; extension uses bearer tokens with an extension Origin | ✅ |
| | E-mail header injection: subjects are stripped of control characters before sending | ✅ new |
| Database | `statement_timeout` 15 s and `idle_in_transaction_session_timeout` 30 s for the runtime role | ✅ new |
| | Migrations checksummed; edited applied migrations are refused | ✅ |
| AI | Gemini key server-only; minimal context (labels/types, never values); schema-constrained output; AI never executes code; never auto-submits | ✅ |
| Extension | No secrets in the bundle; never bypasses CAPTCHA/OTP; never submits | ✅ |
| Monitoring | `/api/metrics` hidden (404) unless the `METRICS_TOKEN` bearer matches; health check exposes no versions or secrets | ✅ new |
| Dependencies | `npm audit` → 0 vulnerabilities (postcss forced to ≥ 8.5.29, nodemailer 10, vitest 4) | ✅ fixed |
| Load | Local load test: health ~970 req/s at 50 concurrent, p95 74 ms; form mapping (21 fields) p95 29 ms; per-user rate limit answers 429 correctly | ✅ |

## Findings fixed in this phase

1. **Admin accounts protected by a password only** → TOTP 2FA, mandatory for admin features.
2. **No way to delete an account** (spec "right to erasure") → `Privacy & Access → Delete account`: password confirmation,
   other sessions signed out, café access and codes ended, learning contributions withdrawn, permanent purge after
   `ACCOUNT_DELETION_GRACE_DAYS` (default 30) by a background job using `eraseUser` (database + stored files).
3. **Audit metadata stored as a JSON string** (phase 12 bug) → fixed in `audit()` plus migration 0013.
4. **Café owners could not close a café** (blocked owner deletion) → `POST /api/cafe/close`.
5. **Vulnerable transitive packages** (postcss in Next, nodemailer, vite via vitest) → upgraded; `npm audit` clean.
6. **Runaway queries could hold connections** → statement / idle-in-transaction timeouts for the runtime role.
7. **No operational visibility** → Prometheus metrics (request counts/latency by route, document queue, café sessions, AI failures, learning age) and
   `GET /api/health?deep=1`.

## Residual risks (accepted, with mitigation path)

| Risk | Why accepted now | Mitigation when needed |
|---|---|---|
| Rate limits are in-memory per process | One web container on the VPS | Move to PostgreSQL/Redis before running several web containers |
| CSP allows `'unsafe-inline'` for styles/scripts (Next.js runtime) | No user HTML is rendered; React escapes output | Nonce-based CSP via middleware |
| A TOTP code can be reused within its 30–90 s window | Code is useless without the password and a fresh challenge token; challenges are single-use | Store the last used time step per user |
| pgvector and GPU fine-tuning not exercised on the dev laptop | Both are optional and fall back cleanly | Run `npm run ml -- vector-setup` and a training run on the VPS / GPU host |
| SMTP is required in production for verification, reset and deletion mails | Dev prints mails to the console | Configure Hostinger SMTP before go-live (sending fails loudly in production without it) |
| Account recovery for a lost authenticator needs both password and a recovery code | By design | Super admin CLI reset (manual identity check) if ever needed |
| No external penetration test yet | Internal review only | Commission one before public launch |

## Re-running the review

```bash
npm run typecheck && npm run lint && npm test && npm run test:db
npm audit --omit=dev
node scripts/load-test.mjs --base http://localhost:3000 -c 50 -d 15
```

Security headers: `curl -sI https://your-domain/login`. Metrics must answer 404 without the token.
