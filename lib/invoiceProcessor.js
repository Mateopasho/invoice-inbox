// lib/invoiceProcessor.js
import { OpenAI } from 'openai';
import { createRequire } from 'module';
import {
  getGraphClient,
  ensureYearMonthFolder,
  uploadFile
} from './onedrive.js';
import { ensureCsvFile, appendCsvRow } from './csvDrive.js';

const require = createRequire(import.meta.url); // for pdf-parse (CJS)

function resolveOpenAI(client) {
  return client ?? new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

export async function processAttachment({ buffer, filename, contentType }, openai) {
  const ai = resolveOpenAI(openai);

  try {
    filename = sanitizeFilename(filename);

    let data;
    if (contentType.includes('pdf')) {
      console.log('📄 Processing PDF file...');
      data = await extractFromPdf(buffer, ai);
    } else if (contentType.startsWith('image/')) {
      console.log('🖼️ Processing Image file...');
      data = await extractFromImage(buffer, ai, contentType);
    } else {
      throw new Error(`Unsupported content type: ${contentType}`);
    }

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

Important: Timelessoft is the company that is going to be processing the invoice. Meaning that the seller is never Timelessoft.
`;
}

function stripFence(str = '') {
  str = str.replace(/[\u200B-\u200D\uFEFF]/g, '');
  const match = str.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (match) return match[1].trim();
  return str.trim();
}

async function extractFromImage(buffer, openai, contentType = 'image/png') {
  const base64 = buffer.toString('base64');

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:${contentType};base64,${base64}` }
          },
          { type: 'text', text: extractionPrompt() }
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

async function parsePdfLocally(buffer) {
  console.log('parsePdfLocally got:', buffer?.constructor?.name, buffer?.length);
  if (!(buffer instanceof Buffer) || buffer.length === 0) {
    throw new Error('Invalid or empty buffer passed to parsePdfLocally');
  }

  const pdfParse = require('pdf-parse');
  const result = await pdfParse(buffer); // primary path
  return result.text || '';
}

async function extractFromPdf(buffer, openai) {
  console.log('ℹ️ Parsing PDF locally with pdf-parse…');
  const text = await parsePdfLocally(buffer);
  if (!text.trim()) throw new Error('Local PDF parse produced no text');

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
