# Chrome extension (phase 4)

Manifest V3, TypeScript, React side panel. Source: `apps/extension`, detection engine: `packages/form-engine`.

## Install (development / your own computers)

```bash
npm run build:extension
```

1. Open `chrome://extensions`, switch on **Developer mode**.
2. **Load unpacked** → select `apps/extension/dist`.
3. Pin "Universal AI Form Assistant" and click its icon → the side panel opens.
4. **Settings** → server address: `http://localhost:3000` (dev) or `https://your-domain` (Hostinger VPS). Chrome asks once for permission to talk to that server.
5. Sign in with your dashboard account.

To publish to the Chrome Web Store later: zip the contents of `dist/` (without `detector.js`, which is dev-only) and upload it.

## What it does now

- **Analyze form**: reads the current page's form structure and shows fields grouped by section, required fields, uploads, already-filled fields, and fields needing manual action (CAPTCHA, OTP, passwords).
- **Live updates**: fields that appear later (Country → State → District), shown/hidden sections and SPA step changes are re-read automatically while the panel is open.
- **Show on page**: click a field in the panel to scroll to it and outline it.
- **Knowledge base**: the form's structure (labels/types, no values) is recorded on your server, so it is recognised next time ("You have analyzed this form before").
- **Profile matching (phase 5)**: every field shows the profile field and value it matches, with confidence and a status (Ready, Review, Needs you, Manual), plus "Missing in your profile". ✓ Correct / ✗ Change teach the system for next time.

Gemini fallback (phase 6): hard fields show an "AI suggestion — please check" review row and a note whether Gemini was used, cached, off or over the daily limit. 

**Filling (phase 7)**

1. Each matched field has a **Fill this** tick: pre-ticked only when it is *Ready*, the value exists and the page field is empty. *Review* fields must be ticked by you ("I checked the value"); for unknown fields you can type or choose an answer (used for this form only).
2. **Review & fill N** opens a preview of every value (sensitive numbers masked), what stays empty, and what you must do yourself (CAPTCHA, OTP, uploads, declarations).
3. **Confirm & fill** — only now does the server return the values; the page is filled field by field in page order (so State appears after Country), filled fields get a green outline.
4. The result lists skipped fields with the reason (hidden, already has a value, not one of the choices, too long, wrong format…); click one to jump to it.
5. **Undo fill** restores every changed field. **I submitted this form** (optional application number) marks it submitted in your history after **you** pressed the website's Submit button.

**Café mode (phase 10)**: café accounts get a café bar — "Filling for: Myself / customer", minutes left, and a box
for the customer's one-time code. Values then come from the customer's profile (only shared categories), the
application is saved in the customer's history, and the panel leaves café mode as soon as the session ends.

**Learning (phase 9)**: a field matched only thanks to other users shows a "learned from others" tag; when the form
changed since your last application the panel warns and asks for more reviews.

**History (phase 8)**: the summary card says when you last applied on this form (with the application number) and
links to it; **☆ Save this form** adds the page to Saved Forms.

The filler uses the browser's native value setter plus `input`/`change` events (works with React/Angular/Vue), picks options of
custom ARIA dropdowns like a user, never replaces a value already on the page unless you allow it, never truncates or
reformats a value the field would reject, and never presses Submit or Enter. File uploads are not filled yet.

## Assistant: “Fill everything”

The chat card under the form. **Fill everything** (or type “fill”, or paste a link to open it first):

1. reads the page and attaches your CV / photo / signature to matching upload boxes;
2. fills everything your profile knows, plus answers you gave before (Dashboard → Saved Answers);
3. writes open answers (“Tell us about yourself”) from your profile — with AI only after you allow sharing your
   professional profile (summary, skills, job, education; never IDs or contact details);
4. asks in chat for required fields it cannot fill and saves the reply to your profile (or to Saved Answers), so the
   same form is filled without questions next time;
5. fills the page visibly (a cursor moves to each field, text is typed) and lists what you must do yourself.

It never solves CAPTCHAs, never fills passwords or OTPs, never ticks “I agree” boxes and never presses Submit. Facts
you tell it (“meri current city Noida hai”, “my notice period is 30 days”) are saved to your profile; ID numbers are
not saved from the chat. **Stop** halts the run at the next step.

## Write email

Second tab in the side panel. Type what you need ("HR ko Accountant post ke liye job application mail likho"), choose tone
and English / हिन्दी / Hinglish, and the assistant drafts it from your profile — name, contact, education, experience,
**Key Skills** and **Professional Summary** (uploading your CV as "Resume / CV" suggests these for review). Ask for changes
in the same chat ("make it shorter"). Edit the subject and text freely, then:

- **Insert into email** — puts it into the open compose window of Gmail or Outlook on the web (or the text box you clicked).
  The draft goes above your signature/quoted reply; an existing subject is kept. **Undo insert** removes it again.
- **Copy** — for any other mail app.

It never presses Send, never attaches files (attach your CV yourself) and never sends anything. Aadhaar, PAN, bank, caste
and family details are never put into an email automatically. AI drafts can contain general phrases — read before sending.
Without Gemini a ready template is used. Dev check: http://localhost:4000/__dev/harness?page=/mail.html (Gmail-like test page).

## Privacy & permissions

| Permission | Why |
|---|---|
| `sidePanel`, `storage` | The UI and your settings/session |
| `activeTab`, `scripting` | Read the page **you** are on, only when you click the icon / Analyze |
| optional site access (asked per site) | "Always allow on this site" — re-read automatically on that site; also asked once for your server |

- No content script runs on every site; nothing is read until you ask.
- Sent to your server: field labels, types, options, section names, page path — **never what you typed on the page**, never the page HTML, never query strings. Answers you type *in the side panel* are sent only when you confirm, and stored encrypted in that application's snapshot.
- The extension stores only an opaque session token (memory-only unless "Keep me signed in"). It never holds Gemini/database keys.
- It never submits forms and never interacts with CAPTCHA/OTP/2FA.

## Detection engine (`packages/form-engine`)

| Concern | Approach |
|---|---|
| Controls | input (all relevant types), textarea, select, contenteditable, ARIA `combobox`/`listbox`/`textbox`; hidden/submit/button/search ignored |
| Labels (in order) | `<label>` → `aria-labelledby`/`aria-label` → previous table cell → nearby text → `title` → `placeholder` → humanised `name`/`id` |
| Groups | radios (and multi-checkbox groups) become one field; question from `<legend>`, ARIA group, or leading text |
| Sections | non-question `<fieldset>` legend, else nearest preceding heading (h2–h6, `role=heading`, captions, common section classes) — inside shadow roots and frames too |
| Flags | required (`required`, `aria-required`, `*`), visibility (styles/attributes), `hasValue` (boolean only), CAPTCHA/OTP/password → manual |
| Reach | open shadow roots, same-origin iframes; cross-origin frames and closed/canvas UIs are reported as unsupported |
| Dynamic | debounced `MutationObserver` + URL polling for SPA navigation |
| Identity | per-field `signature` (kind + name + normalised label) and per-form `formSignature`/`structureHash` (FNV-1a) |

## Testing

- `npm test` — detector unit tests on the real test-form HTML (happy-dom), including dynamic fields and value privacy.
- `npm run test-form` → http://localhost:4000 (form), `/spa` (single-page app), `/__dev/harness` (the built side panel next to the form with a `chrome.*` shim and an API proxy that behaves like the extension — dev only).
