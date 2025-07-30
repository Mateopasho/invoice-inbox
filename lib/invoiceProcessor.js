// lib/invoiceProcessor.js
import fetch from 'node-fetch';
import { OpenAI } from 'openai';
import {
  getGraphClient,
  ensureYearMonthFolder,
  uploadFile
} from './onedrive.js';
import { ensureCsvFile, appendCsvRow } from './csvDrive.js';

export async function processAttachment({ buffer, filename, contentType }, openai) {
  try {
    filename = sanitizeFilename(filename);

    const data = contentType.includes('pdf')
      ? await extractFromPdf(buffer, openai)
      : await extractFromImage(buffer, openai);

    if (!data.invoice_date || !data.total) {
      throw new Error('Missing invoice_date or total in AI output');
    }

    const graph = await getGraphClient();
    const folderId = await ensureYearMonthFolder(graph, data.invoice_date);
    await uploadFile(graph, folderId, filename, buffer);

    const csvId = await ensureCsvFile(graph, folderId);
    await appendCsvRow(graph, csvId, [
      new Date().toISOString(),
      data.invoice_date,
      data.seller,
      data.total,
      data.tax,
      data.payment_method
    ]);

    console.log(`✅ Final filename used for upload: ${filename}`);
    return { ok: true, filename };
  } catch (err) {
    console.error(`❌ ${filename} FULL ERROR:`, err);
    return { ok: false, filename, error: err.message };
  }
}

function sanitizeFilename(filename = '') {
  return filename
    .replace(/[\/\\:*?"<>|#%]/g, '-')
    .replace(/\s+/g, '_')
    .slice(0, 100);
}

function extractionPrompt() {
  return `
Extract the following from the provided text:
- invoice_date (YYYY-MM-DD)
- seller
- total (number, two decimals)
- tax
- payment method

Return ONLY a valid JSON object with those exact keys.
Do NOT wrap the output in \`\`\` fences.
If a value is missing, use an empty string ("").
`;
}

function stripFence(str = '') {
  str = str.replace(/[\u200B-\u200D\uFEFF]/g, '');
  const match = str.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (match) return match[1].trim();
  return str.trim();
}

async function extractFromImage(buffer, openai) {
  const base64 = buffer.toString('base64');

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${base64}` }
          },
          {
            type: 'text',
            text: extractionPrompt()
          }
        ]
      }
    ]
  });

  const parsed = JSON.parse(stripFence(response.choices[0].message.content));
  if (parsed.total_amount !== undefined && parsed.total === undefined) {
    parsed.total = parsed.total_amount;
    delete parsed.total_amount;
  }

  return parsed;
}

async function extractFromPdf(buffer, openai) {
  const res = await fetch(process.env.PDF_EXTRACT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf' },
    body: buffer
  });

  if (!res.ok) {
    throw new Error(`PDF extractor failed: ${res.status} ${res.statusText}`);
  }

  const text = await res.text();

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'user', content: extractionPrompt() },
      { role: 'assistant', content: text }
    ]
  });

  const parsed = JSON.parse(stripFence(response.choices[0].message.content));
  if (parsed.total_amount !== undefined && parsed.total === undefined) {
    parsed.total = parsed.total_amount;
    delete parsed.total_amount;
  }

  return parsed;
}
