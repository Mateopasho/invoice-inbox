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
  // -------------------------------------------------------------------------
  // 1. Validate request
  // -------------------------------------------------------------------------
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  const { from, numMedia = 0, media = [] } = req.body || {};
  if (!from) {
    res.status(400).json({ error: 'Missing "from" in request body' });
    return;
  }

  // -------------------------------------------------------------------------
  // 2. Early exit when there is no media
  // -------------------------------------------------------------------------
  if (Number(numMedia) === 0 || media.length === 0) {
    res.json({ replyBody: 'No attachment found in the message.' });
    return;
  }

  // -------------------------------------------------------------------------
  // 3. Process each attachment
  // -------------------------------------------------------------------------
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const results = await Promise.all(
    media.map(m => processAttachment(m, openai))
  );

  const ok  = results.filter(r => r.ok);
  const err = results.filter(r => !r.ok);

  // -------------------------------------------------------------------------
  // 4. Build reply
  // -------------------------------------------------------------------------
  let replyBody = '';
  if (ok.length)  replyBody += `✅ Processed: ${ok.map(r => r.filename).join(', ')}\n`;
  if (err.length) replyBody += `⚠️ Could not process: ${err.map(r => r.filename).join(', ')}`;

  // Fallback (should not trigger because of early‑exit, but added for safety)
  if (!replyBody.trim()) {
    replyBody = 'No attachment found in the message.';
  }

  // -------------------------------------------------------------------------
  // 5. Return reply to n8n
  // -------------------------------------------------------------------------
  res.json({ replyBody: replyBody.trim() });
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
    return { ok: false, filename };
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

  return JSON.parse(stripFence(response.choices[0].message.content));
}

async function extractFromPdf(buffer, openai) {
  // 1. Send to external PDF text extractor
  const pdfRes = await fetch(process.env.PDF_EXTRACT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf' },
    body: buffer
  });
  const extractedText = await pdfRes.text();

  // 2. Ask ChatGPT to pull out the fields
  const prompt = extractionPrompt();
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'user', content: prompt },
      { role: 'assistant', content: extractedText }
    ]
  });

  return JSON.parse(stripFence(response.choices[0].message.content));
}

function extractionPrompt() {
  return `Extract the following from the provided text:
- invoice_date (YYYY-MM-DD)
- seller
- total_amount (number, two decimals)
- tax
- payment method

You are an invoice extractor. Return ONLY a valid JSON object.`;
}

function stripFence(str = '') {
  return str.replace(/```json\\s*/i, '').replace(/```$/, '').trim();
}