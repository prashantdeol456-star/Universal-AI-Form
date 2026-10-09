# Cyber café mode (implemented — phase 10)

A cyber café fills a form **for** a customer — with the customer's permission, only the categories the customer
chooses, only for as long as they choose, and with everything visible to the customer afterwards.

Code: `apps/web/src/server/cafe/` (`workspace.ts` café side, `customer.ts` customer side, `context.ts` per-request
check), pages `/dashboard/cafe` and `/dashboard/cafe-access`, migration `0010_cafe_mode.sql`, side panel café bar.

## Roles

| Role | How | Can |
|---|---|---|
| `CAFE_OWNER` | signs up as "Café owner", registers the café (Café Workspace) | everything an operator can + invite/disable operators, reports, edit café details |
| `CAFE_OPERATOR` | invited by the owner: a **new work account** (existing accounts are never converted); sets their own password from the e-mailed link (72 h) | start sessions, fill forms for customers |
| Customer | any customer account | approve/reject/stop, create codes, see the café log |

Disabling an operator ends all their open sessions immediately (RLS also checks active membership on every read).

## Starting a session — two ways

**A. One-time code (customer at the counter, recommended).** The customer opens *Café access*, ticks what to share
(defaults: basic, contact, family, education, recruitment, save-application; ID numbers and documents are off unless
chosen), picks a duration (30 min – 12 h) and gets a code like `K7M2-QX9P`. The operator types it in the dashboard or
the side panel → an `ACTIVE` session with exactly those categories. Codes: 8 characters without look-alikes, valid 15
minutes, single use, one live code per customer, stored only as an HMAC; redemption is rate-limited per operator and IP.

**B. Request.** The operator enters the customer's registered email or mobile, categories and purpose. The answer is the
same whether or not the person exists (no account discovery). The customer gets a notification, sees the request in
*Café access*, can **untick** categories (never add) and chooses the duration. Requests expire after 2 hours.

## Filling for a customer (side panel)

Café accounts see a **café bar**: "Filling for: Myself / <customer>", minutes left, and a code box. With a customer
selected, every map/confirm request carries the session id and is re-checked on the server:

- the customer's profile is read **under the operator's database role** — only granted categories are visible;
  fields from other categories show "Not shared by the customer";
- the customer's cloud-AI (Gemini) choice applies;
- the application is saved in the **customer's** history (`customer_id` = customer, `operator_id`, `cafe_id`,
  `cafe_session_id`) — this needs the *Save the application* permission;
- the customer is notified, and `cafe.profile_used` / `cafe.form_filled` appear in their café log;
- if the customer stops access or time runs out, the next request returns `403 cafe_session_ended` and the panel
  switches back to "Myself".

## Database guarantees (0002 + 0010)

- Bank details can never be granted (CHECK constraint + field→permission mapping).
- Session lifecycle is a one-way state machine (trigger, applies to every role): `PENDING → ACTIVE | REJECTED |
  REVOKED | EXPIRED`, `ACTIVE → REVOKED | EXPIRED`; closed sessions are final; parties cannot change; approval needs an
  end time within 12 hours; an active session can be shortened, never extended.
- Only the customer can activate a session; the café can only end it. Permissions are frozen once active.
- Filled values (`application_fields`) are visible to the operator **only while** the session that allows
  *applications* is active; afterwards the café keeps metadata only (form, website, status, dates). Café owners never
  see values.
- Access codes are readable only by their customer; the runtime role cannot mark them used.
- A maintenance timer marks finished sessions `EXPIRED` every 5 minutes (access already ended via `expires_at > now()`).

## Reports (owner)

Last 30 days: forms filled, marked submitted, customers served, approved sessions, forms per day, per-operator table,
recent forms (form name, customer name, operator, status) — never field values.
