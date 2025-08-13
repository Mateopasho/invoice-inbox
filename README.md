## Flow (What Happens)
1) **Extraction**
   - **WhatsApp (Twilio Sandbox):** Twilio hits the deployed webhook → downloads the media URL → forwards the file for processing.
   - **Email (Google API):** Local script fetches the newest email with attachments → forwards each file for processing.
     - One-time **token generation** is required: this is automated from `getAuthCode.js` its gets a refresh code from Google app in the permited url for testing.

2) **Processing (OpenAI)**
   - File → OpenAI → returns structured JSON (supplier, invoice number, date, totals, etc.).

3) **Storage (OneDrive)**
   - Upload original file to target folder (e.g., `YYYY.MM/`).
   - Append a row to `invoices.csv` in that folder.

## Files That Matter
- **API/Webhook**
  - `api/index.js` — Twilio webhook handler (downloads media, calls processor, returns short reply).
- **Email**
  - `getAuthCode.js` — Google OAuth **token generator** (creates `token.json` from `credentials.json`).
  - `fetchFirstEmail.js` — Fetches newest email + attachments via Gmail API.
- **Processing & Storage**
  - `lib/openai.js` — Runs extraction and returns normalized JSON.
  - `lib/graph.js` — Uploads file + updates `invoices.csv` in OneDrive.
  - `lib/csv.js` — Appends a row to the CSV.

> Not necessary in production: `test-fetchEmails.js` (dev only).  
> Not needed in git: `api/attachments/` (ignore/remove if unused).