# Invoice Inbox (Vercel)

A serverless API that:

1. Receives JSON from n8n (Twilio webhook proxy)
2. Downloads WhatsApp media from Twilio
3. Extracts invoice data with OpenAI (Vision for images, Chat for PDFs)
4. Saves the original file to OneDrive under `YYYY.MM/`
5. Appends a row to `invoices.csv` inside that folder (creates the file if missing)
6. Returns a `replyBody` string for n8n to send back to the WhatsApp user

---

## Local dev

```bash
npm install
vercel dev
Set your environment variables locally (or create a .env file) before running.
```