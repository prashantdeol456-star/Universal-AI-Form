# Security

## Implemented (phase 1)

| Control | Implementation |
|---|---|
| Password storage | scrypt (N=2^15, r=8, p=1, 64-byte key, per-user salt); params stored with hash and upgraded on login (`needsRehash`) |
| Sessions | 256-bit random opaque tokens; only SHA-256 stored; server-side revocation; 30-day expiry; httpOnly + `SameSite=Lax` + `Secure` in production |
| Brute force | Per-IP and per-email rate limits; account lock for 15 min after 10 failures; constant-time comparison and dummy hash for unknown emails |
| OTP | 6 digits from CSPRNG, stored as HMAC-SHA256 (keyed with `AUTH_SECRET`), 15 min expiry, 5 attempts |
| Password reset | Single-use token (SHA-256 stored), 30 min expiry, revokes every session; response never reveals whether the account exists |
| CSRF | Origin/Referer must equal `APP_URL` for cookie-authenticated mutations; bearer requests exempt |
| Authorization | RBAC in `packages/shared/src/roles.ts` **and** PostgreSQL RLS on a non-superuser role (defence in depth) |
| Tenant isolation | RLS on every personal/tenant table; tested in `database/tests/rls.test.ts` |
| Sensitive data | AES-256-GCM field encryption (Aadhaar, PAN, passport, DL, voter ID, salary, PwD, all bank fields, sensitive custom fields); key rotation via key IDs; masked in UI; reveals are audited |
| Bank data | Never readable by café operators (no café permission maps to `bank.*`) |
| Admin privacy | Super admins have no RLS path to profile values |
| Audit | Append-only `audit_logs` for auth, profile changes, reveals, exports; metadata redacted |
| Logging | Server errors pass through `redact()` (Aadhaar, PAN, IFSC, email, mobile, long numbers, tokens) |
| Input validation | zod on every API body; per-field validators (Verhoeff checksum for Aadhaar, PAN/IFSC formats, dates, etc.) |
| HTTP headers | CSP, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy; HSTS via Caddy |
| Secrets | Only in `.env` (gitignored, `chmod 600` on server); never sent to the browser or extension |
| Network | Only Caddy (80/443) exposed; PostgreSQL and Ollama on the private Docker network |

## Documents (phase 2)

| Control | Implementation |
|---|---|
| Type validation | Magic bytes only (PDF, JPEG, PNG, WEBP); client MIME/extension ignored |
| Malicious PDFs | Rejected if they contain `/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFile`, `/RichMedia`, `/XFA` |
| Antivirus | ClamAV `INSTREAM` client; optional container; status recorded (`CLEAN/INFECTED/SKIPPED/ERROR`), never claims "clean" when skipped; infected files deleted and audited |
| Limits | `MAX_UPLOAD_MB` (app) + 25 MB (Caddy); 60 MP image decode limit; 30 uploads/hour/user |
| At rest | Every file AES-256-GCM encrypted (`UFAE1` envelope, key id authenticated) on the Docker volume; OCR text and sensitive extracted values encrypted in PostgreSQL |
| Access | Files served only via 5-minute HMAC-signed URLs **plus** session + RLS check; `Content-Security-Policy: sandbox`, `nosniff`, `no-store` |
| Paths | Storage keys are server-generated (`users/<uuid>/<uuid>.<ext>`), validated against traversal |
| AI | Local model output restricted by JSON schema to allowed field keys, re-validated with zod, confidence capped at 0.85; never written to the profile without user confirmation |

## Planned

- Phase 4: extension token scoping, short-lived extension tokens with refresh.
- Phase 12: admin pages and APIs require `admin:*` permissions and every admin service re-checks them; admins see counts and structure only — a unit test fails the build if admin code references profile values, filled values, document text, chat, storage keys, password hashes or decryption; admins cannot act on themselves, on other admins, or grant SUPER_ADMIN (CLI only); suspension signs the user out everywhere and ends their café sessions; café suspension is enforced by RLS; every admin action needs a reason and is audited.
- Phase 11: datasets only from consensus or admin-approved examples, PII-checked twice (builder + validation) and structure-only; label-hash splits prevent test leakage; promotion gated on wrong-mapping rate against the same frozen test set, audited, and never deploys; vector store holds shared verified labels only, system-only access, graceful fallback.
- Phase 10: café sessions re-checked on every request; RLS limits the operator to granted categories (bank never); one-way session state machine with a 12-hour cap enforced by a trigger for every role; values hidden from cafés after the session; single-use HMAC-hashed codes with short validity and rate-limited redemption; access requests answer identically for unknown people; operator accounts are separate work accounts (no conversion of personal accounts); every café action audited with `cafe_id` and shown to the customer.
- Phase 9: shared knowledge writable only by the server job (RLS denies the runtime role); k-style thresholds (≥2 / ≥3 distinct users) so one account cannot poison shared mappings; distinct-user counting, agreement thresholds and automatic demotion; no user ids in shared rows; examples carry no values and honour opt-out/withdrawal; run log not readable by the runtime role.
- Phase 8: snapshot values masked in history; full values only via an explicit, rate-limited, audited reveal; document links restricted to your own documents by RLS (not only by the API); CSV export carries no field values and neutralises spreadsheet formulas; saved-form URLs stored without query strings.
- Phase 7: filling only after explicit confirmation; the server (not the extension) reads profile values; CAPTCHA/OTP/password/upload fields rejected server-side too; encrypted immutable snapshot with column grants + status-transition trigger; filler never submits, never overwrites without permission, executes no server/AI code; fill telemetry carries statuses, never values.
- Phase 6: Gemini key server-side only (`x-goog-api-key` header, never in URLs/logs/extension); request minimisation (label/section/type/options only); response JSON schema + zod validation, unknown keys dropped; confidence cap so Gemini can never auto-fill; daily per-user budget; per-user opt-out; telemetry stores counts, not content.
- Phase 13: TOTP two-step verification (secret encrypted, recovery codes hashed, both unreadable by the runtime role), mandatory for admin permissions; new-device notifications; account erasure; COOP/CORP headers; statement/idle timeouts for the runtime role; token-protected metrics; e-mail subject sanitising; `npm audit` clean. Full checklist, findings and residual risks: [SECURITY_REVIEW.md](SECURITY_REVIEW.md).

## Operational rules

- Never run the web app with the owner credentials as `DATABASE_APP_URL`.
- Back up `DATA_ENCRYPTION_KEYS` separately from database backups.
- To rotate the encryption key: prepend a new key (`k2:…,k1:…`), deploy, run a re-encryption job (to be added), then remove `k1`.
- The in-memory rate limiter assumes a single web container; move it to Redis/Postgres before scaling horizontally.
- Run `npm audit --omit=dev` before every deployment; keep it at 0 vulnerabilities.
- Every administrator must turn on two-step verification (Settings → Two-step verification) before admin pages open. Keep `ADMIN_REQUIRE_MFA=true` in production.
