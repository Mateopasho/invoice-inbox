import { OpenAI } from 'openai';
import fetch from 'node-fetch';
import twilio from 'twilio';
import {
  getGraphClient,
  ensureYearMonthFolder,
  uploadFile
} from '../lib/onedrive.js';
import { ensureCsvFile, appendCsvRow } from '../lib/csvDrive.js';

export default async function handler(req, res) {
  try {
    // -----------------------------------------------------------------------
    // 1. Validate request method
    // -----------------------------------------------------------------------
    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed');
      return;
    }

    // -----------------------------------------------------------------------
    // 2. Validate body
    // -----------------------------------------------------------------------
    const { from, numMedia = 0, media = [] } = req.body || {};

    if (!from) {
      res.status(400).json({ error: 'Missing "from" in request body' });
      return;
    }

    if (Number(numMedia) === 0 || media.length === 0) {
      res.json({ replyBody: 'No attachment found in the message.' });
      return;
    }

    // -----------------------------------------------------------------------
    // 3. Validate each media item before processing
    // -----------------------------------------------------------------------
    const validatedMedia = media.map((m, idx) => {
      const { url, contentType, filename } = m || {};

      if (!url) {
        return {
          ok: false,
          filename: filename || `media_${idx}`,
          error: 'Missing media URL'
        };
      }

      if (!contentType) {
        return {
          ok: false,
          filename: filename || url.split('/').pop() || `media_${idx}`,
          error: 'Missing content type'
        };
      }

      return { ok: true, url, contentType, filename };
    });

    // Split into items that can be processed vs. items that already failed
    const toProcess = validatedMedia.filter(m => m.ok);
    const preErrors  = validatedMedia.filter(m => !m.ok);

    // -----------------------------------------------------------------------
    // 4. Process each valid attachment
    // -----------------------------------------------------------------------
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const processedResults = await Promise.all(
      toProcess.map(m => processAttachment(m, openai))
    );

    // Merge early validation errors with processing results
    const results = [...preErrors, ...processedResults];

    const ok  = results.filter(r => r.ok);
    const err = results.filter(r => !r.ok);

    // -----------------------------------------------------------------------
    // 5. Build reply
    // -----------------------------------------------------------------------
    let replyBody = '';

    if (ok.length) {
      replyBody +=
        '✅ Processed:\n' +
        ok.map(r => `• ${r.filename}`).join('\n') +
        '\n\n';
    }

    if (err.length) {
      replyBody +=
        '⚠️ Could not process:\n' +
        err.map(r => `• ${r.filename} – ${r.error}`).join('\n');
    }

    // Fallback (should not trigger because of earlier checks)
    if (!replyBody.trim()) {
      replyBody = 'No attachment found in the message.';
    }

    // -----------------------------------------------------------------------
    // 6. Return reply to n8n
    // -----------------------------------------------------------------------
    res.json({ replyBody: replyBody.trim() });
  } catch (fatal) {
    // Any unexpected error that escaped the pipeline
    console.error('💥 Fatal error in handler:', fatal);
    res.status(500).json({
      replyBody:
        '⚠️ An unexpected error occurred while processing your message. Please try again later.'
    });
  }
}

// ---------------------------------------------------------------------------
// Per‑attachment pipeline
// ---------------------------------------------------------------------------
async function processAttachment({ url, contentType, filename }, openai) {
  try {
    // 1. Download from Twilio
    const buffer = await downloadFromTwilio(url);

    // 2. Extract invoice data
    const data = contentType.includes('pdf')
      ? await extractFromPdf(buffer, openai)
      : await extractFromImage(buffer, openai);

    if (!data.invoice_date || !data.total) {
      throw new Error('Missing invoice_date or total in AI output');
    }

    // 3. OneDrive (folder + file)
    const graph    = await getGraphClient();
    const folderId = await ensureYearMonthFolder(graph);
    await uploadFile(graph, folderId, filename, buffer);

    // 4. CSV (create if missing, then append)
    const csvId = await ensureCsvFile(graph, folderId);
    await appendCsvRow(graph, csvId, [
      new Date().toISOString(),
      data.invoice_date,
      data.seller,
      data.total,
      data.tax,
      data.payment_method
    ]);

    return { ok: true, filename };
  } catch (err) {
    console.error(`❌ ${filename}:`, err.message);
    return { ok: false, filename, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function downloadFromTwilio(url) {
  const res = await fetch(url, {
    headers: {
      Authorization:
        'Basic ' +
        Buffer.from(
          `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
        ).toString('base64')
    }
  });
  if (!res.ok) {
    throw new Error(`Failed to download media: ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function extractFromImage(buffer, openai) {
  const base64 = buffer.toString('base64');
  const prompt = extractionPrompt();

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'user', content: prompt },
      { role: 'user', content: { type: 'image_url', image_url: { base64 } } }
    ]
  });

  // --- TEMP LOGS -----------------------------------------------------------
  console.log('AI RAW IMAGE OUTPUT:', response.choices[0].message.content);
  // -------------------------------------------------------------------------

  const parsed = JSON.parse(stripFence(response.choices[0].message.content));

  // --- TEMP LOGS -----------------------------------------------------------
  console.log('AI PARSED IMAGE OUTPUT:', parsed);
  // -------------------------------------------------------------------------

  return parsed;
}

async function extractFromPdf(buffer, openai) {
  // 1. Send to external PDF text extractor
  const pdfRes = await fetch(process.env.PDF_EXTRACT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf' },
    body: buffer
  });

  if (!pdfRes.ok) {
    throw new Error(
      `PDF extractor returned ${pdfRes.status} ${pdfRes.statusText}`
    );
  }

  const extractedText = await pdfRes.text();

  // --- TEMP LOG ------------------------------------------------------------
  console.log('EXTRACTED PDF TEXT (first 300):', extractedText.slice(0, 300));
  // -------------------------------------------------------------------------

  // 2. Ask ChatGPT to pull out the fields
  const prompt = extractionPrompt();
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'user', content: prompt },
      { role: 'assistant', content: extractedText }
    ]
  });

  // --- TEMP LOGS -----------------------------------------------------------
  console.log('AI RAW PDF OUTPUT:', response.choices[0].message.content);
  // -------------------------------------------------------------------------

  const parsed = JSON.parse(stripFence(response.choices[0].message.content));

  // --- TEMP LOGS -----------------------------------------------------------
  console.log('AI PARSED PDF OUTPUT:', parsed);
  // -------------------------------------------------------------------------

  return parsed;
}

function extractionPrompt() {
  return `
Extract the following from the provided text:
- invoice_date (YYYY-MM-DD)
- seller
- total_amount (number, two decimals)
- tax
- payment method

Return ONLY a valid JSON object with those exact keys.
Do NOT wrap the output in \`\`\` fences.
If a value is missing, use an empty string ("").

Example:

{
  "invoice_date": "2025-01-18",
  "seller": "OMV Downstream GmbH",
  "total": 94.05,
  "tax": 0.00,
  "payment_method": "Credit Card"
}
`;
}

// ---------------------------------------------------------------------------
// Improved stripFence helper
// ---------------------------------------------------------------------------
function stripFence(str = '') {
  // 1. Remove zero‑width and non‑breaking spaces
  str = str.replace(/[\u200B-\u200D\uFEFF]/g, '');

  // 2. Capture content between ```json ... ``` fences (or plain ``` ... ```)
  const match = str.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (match) {
    return match[1].trim();
  }

  // 3. If no fences, just trim and return
  return str.trim();
}