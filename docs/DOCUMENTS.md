# Documents (phase 2)

```
Upload (API, synchronous)                       Background worker (inside the web process)
──────────────────────────                      ─────────────────────────────────────────────
size limit (MAX_UPLOAD_MB)                      claim next UPLOADED doc (FOR UPDATE SKIP LOCKED)
magic-byte type check (PDF/JPG/PNG/WEBP)    ┌─► antivirus (ClamAV if configured, else SKIPPED)
PDF active-content rejection (JS/Launch/…)  │   text: PDF text layer (pdf.js) | image OCR (sharp + Tesseract eng+hin)
image decode check, dimensions              │   rules extractor  (+ local AI via Ollama, if enabled)
SHA-256 duplicate check                     │   validate with profile catalog validators; drop disallowed fields
encrypt (AES-256-GCM) → disk volume         │   store PENDING extractions (sensitive values encrypted)
insert row (status UPLOADED) ───────────────┘   compare with profile + other documents → OPEN conflicts
                                                status EXTRACTED (OCR text stored encrypted)
User review (dashboard)
───────────────────────
Confirm / Edit+Confirm → profile via updateField (source=document, verified, source_document_id)
Wrong — ignore → REJECTED
Conflict → user picks the correct value (or types one) → profile updated, other candidates rejected
```

**Nothing is written to the profile without a user action.** Verified profile values are never replaced by a document
silently: a different value creates a conflict the user resolves.

## What is read from each document type

`packages/document-engine/src/targets.ts` limits fields per type (anything else an extractor or model returns is dropped):

| Type | Fields |
|---|---|
| Aadhaar | number (Verhoeff-checked), name, DOB, gender, S/O·D/O → father, W/O → spouse, PIN, state |
| PAN | number, name, father's name, DOB (labelled and old layouts) |
| Class 10 / 12 marksheet | name, father, mother, DOB, board, school, roll no., year, percentage (or computed from totals), stream |
| Graduation / degree / diploma | course, university, college, CGPA, percentage, year, roll and registration no. |
| Caste / domicile / EWS / disability certificates | name, father, category, caste, certificate no., domicile state, EWS / PwD flags |
| Experience certificate / salary slip | name, company, designation, department, employee ID, joining date |
| Resume | name, email, mobile, DOB |
| Photograph, signature, other | stored only (for form uploads in phase 7); nothing extracted |

## Known limits (honest)

- **Scanned PDFs** (no text layer) are not OCR'd yet — the user is asked to upload a photo/image scan. Planned: rasterise PDF pages for OCR.
- OCR quality depends on the photo: blur, glare, tilt and handwriting reduce accuracy. The confidence badge and side-by-side preview are there so the user checks each value.
- Rule extractors cover common layouts of central documents and CBSE-style marksheets; state-board layouts vary. Local AI (phase 5 provider, already pluggable here) improves coverage; every value still needs confirmation.
- Antivirus requires the optional ClamAV container (~1.5–3 GB RAM).
- The worker runs inside the web container (one document at a time). For heavy use, run a second instance with `DOCUMENT_WORKER_ENABLED=true` and the web one with `false` — the queue is already safe for multiple workers.
