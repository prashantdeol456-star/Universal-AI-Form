# Deployment — Hostinger VPS (self-hosted, no Supabase)

Everything runs on **one VPS** with Docker Compose:

```
Internet ──► Caddy :80/:443 (automatic HTTPS) ──► web (Next.js :3000) ──► PostgreSQL 16 (+pgvector)
                                                        │
                                                        ├──► /app/storage volume (uploaded documents)
                                                        └──► ollama (optional, phase 5, private network only)
```

Only ports 22, 80 and 443 are open. PostgreSQL and the AI server are never exposed to the internet.

## 1. Choose a VPS plan

| Use | Hostinger plan | Notes |
|---|---|---|
| Web + database only (phases 1–4, Gemini fallback) | **KVM 2** (2 vCPU, 8 GB RAM) | Comfortable for hundreds of users |
| + local AI on CPU (7B model, slow but works) | **KVM 4** (4 vCPU, 16 GB) | Expect several seconds per AI call |
| Production local AI | Keep KVM 2/4 for the app, run the model on a separate GPU server | Point `LOCAL_AI_BASE_URL` at it over a private/authenticated link |

OS template: **Ubuntu 24.04 LTS** (or Hostinger's "Ubuntu 24.04 with Docker" template, which lets you skip step 3).

## 2. Point your domain

In your DNS panel (Hostinger hPanel → Domains → DNS), create an **A record**:
`forms.example.com → <your VPS IP>`. Wait until `ping forms.example.com` shows the VPS IP.

## 3. Prepare the server (once)

SSH in as root (hPanel shows the IP and root password / lets you add an SSH key):

```bash
ssh root@<VPS_IP>
```

```bash
apt update && apt -y upgrade
adduser deploy && usermod -aG sudo deploy
# Docker Engine + Compose plugin (official script)
curl -fsSL https://get.docker.com | sh
usermod -aG docker deploy
# Firewall: only SSH + web
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw --force enable
# Automatic security updates
apt -y install unattended-upgrades && dpkg-reconfigure -f noninteractive unattended-upgrades
```

Hostinger also has a VPS-level firewall in hPanel — if you enable it, allow the same ports there.

## 4. Get the code onto the server

```bash
su - deploy
sudo mkdir -p /opt/ufa && sudo chown deploy:deploy /opt/ufa
git clone <your-git-repo-url> /opt/ufa      # or upload with scp/rsync
cd /opt/ufa
```

## 5. Configure secrets

```bash
cp .env.production.example .env
docker run --rm node:22-alpine node -e "const c=require('crypto');const a=n=>c.randomBytes(n).toString('hex');console.log('POSTGRES_PASSWORD='+a(24)+'\nDB_APP_PASSWORD='+a(24)+'\nAUTH_SECRET='+c.randomBytes(48).toString('base64url')+'\nDATA_ENCRYPTION_KEYS=k1:'+c.randomBytes(32).toString('base64'))"
nano .env      # paste the 4 generated values, set DOMAIN, APP_URL and SMTP_*
chmod 600 .env
```

**Store `DATA_ENCRYPTION_KEYS` in a password manager now.** Aadhaar/PAN/bank values are encrypted with it; a database backup without the key cannot be decrypted.

SMTP: create a mailbox in hPanel → Emails (e.g. `no-reply@yourdomain`) and use `smtp.hostinger.com`, port `465`, `SMTP_SECURE=true`.

## 6. Start

```bash
docker compose up -d --build
docker compose ps            # postgres healthy, migrate exited 0, web healthy, caddy up
docker compose logs -f web   # Ctrl+C to stop following
```

Open `https://forms.example.com` — Caddy obtains the TLS certificate on the first request.

Create the first super admin:

```bash
docker compose run --rm -e ADMIN_EMAIL=you@example.com -e ADMIN_PASSWORD='a-long-unique-password' migrate \
  npx tsx packages/db/src/cli.ts create-admin
```

## 7. Backups (do not skip)

```bash
chmod +x scripts/*.sh
(crontab -l 2>/dev/null; echo "30 2 * * * cd /opt/ufa && ./scripts/backup-db.sh >> /var/log/ufa-backup.log 2>&1") | crontab -
```

This writes a `pg_dump` and an uploads archive to `/opt/ufa-backups` nightly and keeps 14 days. Copy that folder **off the server** (e.g. `rclone` to Google Drive/S3) — Hostinger's weekly VPS snapshot is a useful extra, not a replacement.

Restore:

```bash
docker compose exec -T postgres pg_restore -U ufa_owner -d ufa --clean --if-exists < /opt/ufa-backups/db-YYYYMMDD-HHMMSS.dump
```

## 8. Updating

```bash
cd /opt/ufa && ./scripts/deploy.sh
```

`git pull` → rebuild → `migrate` runs pending migrations (it refuses to run if an already-applied migration file was edited) → `web` restarts only after migrations succeed.

## 9. Optional: local AI (phase 5)

```bash
docker compose --profile local-ai up -d ollama
docker compose exec ollama ollama pull qwen2.5:7b-instruct
```

Optional semantic matching: `docker compose exec ollama ollama pull nomic-embed-text` and set `LOCAL_AI_EMBED_MODEL=nomic-embed-text`.

Set `LOCAL_AI_ENABLED=true` in `.env` and `docker compose up -d web`. The model name is configuration, not code. Ollama has no authentication, so it stays on the private compose network; if it runs on a separate GPU server, put it behind a reverse proxy with a token and set `LOCAL_AI_API_KEY`.

## Optional: Gemini fallback

Create an API key in Google AI Studio and set in `.env`: `GEMINI_ENABLED=true`, `GEMINI_API_KEY=…`, optionally
`GEMINI_MODEL` (default `gemini-3.5-flash`), `GEMINI_DAILY_FIELD_LIMIT` (per user, default 200),
`GEMINI_MAX_FIELDS_PER_REQUEST` (40), `AI_CACHE_TTL_DAYS` (30). Then `docker compose up -d web`. The key stays on the
server; only outbound HTTPS to `generativelanguage.googleapis.com` is needed. Users can switch it off in Settings.
Verify key + model + request format from a checkout with `npm run check:gemini` (one tiny request, no user data).

## Administrators

The first super admin is created on the server with `create-admin` (see the step above); never from the web UI. The admin area is `/dashboard/admin`.

Admin pages and APIs require **two-step verification** (`ADMIN_REQUIRE_MFA=true`, the default — keep it on). After the
first sign-in the admin is sent to Settings → Two-step verification: scan the code with an authenticator app
(Google Authenticator, Microsoft Authenticator, Aegis, 1Password …), confirm with a code and the password, and store the
8 recovery codes offline. Every other user can turn it on too.

## Account deletion

Users delete their own account from Privacy & Access. It is permanent after `ACCOUNT_DELETION_GRACE_DAYS` (default 30,
1–90); an hourly job inside the web process erases the database rows and the encrypted files. Backups still contain the
data until they rotate out — keep backup retention short (the nightly job keeps 14 days) and say so in your privacy notice.
Deletion and reminder e-mails need SMTP (`SMTP_HOST` …) — configure it before go-live.

## Monitoring

- **Uptime**: point an uptime checker (UptimeRobot, Better Stack, Hostinger monitoring) at `https://your-domain/api/health`
  (200 = app + database ok). `https://your-domain/api/health?deep=1` also checks migrations, the document worker heartbeat and
  the document queue (503 if any is unhealthy).
- **Metrics**: set `METRICS_TOKEN` to a long random value (`openssl rand -hex 32`) and `docker compose up -d web`. Prometheus
  (or Grafana Agent / Alloy) scrapes `https://your-domain/api/metrics` with `Authorization: Bearer <token>`: request counts and
  latency histograms per route and status (`ufa_http_*`), documents queued/failed, active café sessions, AI requests and
  failures in the last hour, age of the last learning run, accounts pending deletion, database size, process memory and
  uptime. Good first alerts: `ufa_documents_failed` rising, `ufa_ai_failures_1h` > 0 for long, learning age > 2 h. Without a
  token the endpoint answers 404.
- **Logs**: `docker compose logs -f web`. Logs never contain profile values, documents, passwords, OTPs or tokens.
- **Database**: the runtime role has `statement_timeout = 15s`; slow queries fail instead of piling up — check the logs for
  `canceling statement due to statement timeout`.

## Load test before launch

From your laptop or the VPS (only against your own server):

```bash
node scripts/load-test.mjs --base https://your-domain -c 50 -d 30
```

On a KVM 2 expect hundreds of health requests per second. Form mapping is rate-limited to 60 per minute per user, so a
mapping load test against one account mostly returns 429 — that is intended; read `successLatency_ms`.

## Learning engine

Runs inside the web process (no extra service). Settings in `.env`: `LEARNING_ENABLED=true`,
`LEARNING_INTERVAL_MINUTES=30`, `LEARNING_WEBSITE_MIN_USERS=2`, `LEARNING_GLOBAL_MIN_USERS=3` (minimums are enforced).
Several web containers are safe: an advisory lock lets one run at a time.

## Optional: vector search and fine-tuned models

The bundled PostgreSQL image already includes pgvector, so `label_embeddings` exists after `migrate`. With local AI
running: `docker compose exec ollama ollama pull nomic-embed-text`, set `LOCAL_AI_EMBED_MODEL=nomic-embed-text`, then
`npm run ml -- embed-labels` once (from a checkout that can reach the database); the learning job keeps it updated.

Fine-tuning happens on a separate GPU machine (see docs/ML_TRAINING.md). After a model passes `npm run ml -- promote`,
copy the GGUF + Modelfile to the Ollama host, `ollama create ufa-mapper:vN -f Modelfile`, set `LOCAL_AI_MODEL=ufa-mapper:vN`
and `docker compose up -d web`. Rollback = `npm run ml -- rollback` and the previous tag.

## Optional: antivirus for uploads

```bash
docker compose --profile antivirus up -d clamav     # first start downloads signatures (a few minutes)
echo "CLAMAV_HOST=clamav" >> .env && docker compose up -d web
```

ClamAV needs ~1.5–3 GB RAM — use KVM 4 or larger. Without it, uploads are still type-checked and PDF scripts are blocked, and the UI says "scan skipped".

Uploaded documents live encrypted in the `uploads` volume and are included in the nightly backup; restoring them needs the same `DATA_ENCRYPTION_KEYS`.

## Chrome extension for your users

Build once (`npm run build:extension`), then either load `apps/extension/dist` unpacked on café/office computers, or publish
it to the Chrome Web Store. In the side panel → Settings, set the server address to `https://your-domain`. The extension
only accepts `https://` servers (plain `http` is allowed for `localhost` only).

## Useful commands

| Task | Command |
|---|---|
| Logs | `docker compose logs -f --tail=200 web` |
| DB shell | `docker compose exec postgres psql -U ufa_owner -d ufa` |
| Migration status | `docker compose run --rm migrate npx tsx packages/db/src/cli.ts status` |
| Restart app | `docker compose restart web` |
| Disk usage | `docker system df` and `df -h` |

## Why not Vercel + Supabase?

The original plan used both. This deployment replaces them with self-hosted equivalents:

| Supabase/Vercel feature | Self-hosted replacement here |
|---|---|
| Supabase Postgres | PostgreSQL 16 container (`pgvector/pgvector:pg16`) |
| Supabase Auth | Built-in auth: scrypt passwords, opaque DB sessions, email OTP, reset links (`apps/web/src/server/auth`) |
| Supabase RLS with `auth.uid()` | Same PostgreSQL RLS; identity passed with `set_config('app.user_id', …)` per transaction to a non-superuser role |
| Supabase Storage + signed URLs | Docker volume + HMAC-signed, expiring download URLs (`packages/security/src/tokens.ts`); S3-compatible driver can be added later |
| Vercel hosting | Next.js `standalone` build behind Caddy with automatic HTTPS |
