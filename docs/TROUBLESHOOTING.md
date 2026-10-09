# Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Invalid server environment: ...` on start | A required variable in `.env` is missing or too short (e.g. `AUTH_SECRET` < 32 chars). The message lists which. |
| `password authentication failed for user "ufa_app"` | `DB_APP_PASSWORD` and the password in `DATABASE_APP_URL` differ. Fix `.env`, then `npm run db:migrate` (it resets the role password). |
| `Applied migrations were modified` | An already-applied SQL file was edited. Revert it and add a new migration. |
| `permission denied for table ...` from the app | Query ran on the `ufa_app` pool without a needed grant, or a system-only table was queried via `asUser`. |
| Data "disappears" in a query | RLS: the query ran without `asUser()` (no `app.user_id`) or as a different user. |
| `Cross-site request blocked` | `APP_URL` does not exactly match the URL in the browser (scheme, host, port). |
| No verification email in dev | Without `SMTP_HOST` the code is printed in the `npm run dev` console. |
| Caddy cannot get a certificate | The domain's A record does not point to the VPS yet, or ports 80/443 are blocked (ufw / Hostinger firewall). |
| `npm run dev:db` fails on port | Another PostgreSQL uses the port in `DATABASE_URL`; change the port in both URLs. |
| `Database encoding is WIN1252; UTF8 is required` | The database was created with a non-UTF-8 encoding (common with local Windows installs). Recreate it with `ENCODING 'UTF8'`. For `npm run dev:db`, delete `.data/postgres` and start again. |
| Gemini calls fail with HTTP 401/403 although `.env` has a key | A `GEMINI_API_KEY` (or other variable) set in the operating-system environment wins over `.env` — `.env` never overrides existing variables. Remove/update the OS variable (Windows: *Edit environment variables for your account*) or unset it before `npm run dev`. |
| Side panel says "Gemini unavailable" | `GEMINI_ENABLED=false`, no `GEMINI_API_KEY`, the user switched off cloud AI in Settings, or the daily limit `GEMINI_DAILY_FIELD_LIMIT` is reached. Server log shows `GeminiError` for HTTP failures. |
| A field shows "Skipped — hidden" after filling | It was hidden at that moment (e.g. a section that opens after another answer). Analyze again and fill the remaining fields. |
| "Already has a value on the page (not replaced)" | You typed something there before. Tick *Page already has a value: replace it* in the panel if you want it replaced. |
| "The page did not accept the value" | The website's own script cleared or rejected it (masked inputs, custom widgets). Fill that one by hand. |
| Encrypted values unreadable after restore | `DATA_ENCRYPTION_KEYS` differs from the one used when the data was written. |
