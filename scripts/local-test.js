#!/usr/bin/env node
/**
 * scripts/local-test.js
 *
 * A single-file, local-only version of your pipeline:
 * - Watches ATTACHMENTS_DIR for new files (same as your watcher)
 * - Extracts data (OpenAI Vision for images, PDF → text → OpenAI for PDFs)
 * - Stores the original file under OUTPUT_DIR/YYYY.MM/
 * - Appends a row to OUTPUT_DIR/YYYY.MM/invoices.csv
 * - Moves the source file to <attachments>/processed or <attachments>/failed
 *
 * Env:
 *   ATTACHMENTS_DIR=api/attachments   (default)
 *   OUTPUT_DIR=local_out              (default)
 *   OPENAI_API_KEY=...                (required for AI extraction)
 *   PDF_EXTRACT_ENDPOINT=...          (optional; if missing, uses pdf-parse locally)
 */

import chokidar from 'chokidar';
import path from 'path';
import fs from 'fs/promises';
import fssync from 'fs';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { OpenAI } from 'openai';

dotenv.config();

// ────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────
const DEFAULT_ATTACHMENTS_DIR = path.join('api', 'attachments');
const ATTACHMENTS_DIR = path.resolve(process.env.ATTACHMENTS_DIR ?? DEFAULT_ATTACHMENTS_DIR);
const PROCESSED_DIR = path.join(ATTACHMENTS_DIR, 'processed');
const FAILED_DIR = path.join(ATTACHMENTS_DIR, 'failed');

const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR ?? 'local_out'); // where we "upload"
const REQUIRE_AI = true; // set to false if you add your own regex fallback later

// One OpenAI client instance
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ────────────────────────────────────────────────────────────
// Utilities (same spirit as your current code)
// ────────────────────────────────────────────────────────────
async function ensureDirs() {
  for (const d of [ATTACHMENTS_DIR, PROCESSED_DIR, FAILED_DIR, OUTPUT_DIR]) {
    if (!fssync.existsSync(d)) await fs.mkdir(d, { recursive: true });
  }
}

function isFinalInvoice(name) {
  const base = name.toLowerCase();
  if (base.startsWith('.')) return false;
  if (
    base.endsWith('.crdownload') ||
    base.endsWith('.download') ||
    base.endsWith('.partial')
  ) return false;
  return /\.(pdf|png|jpg|jpeg|webp|tif|tiff|heic)$/i.test(base);
}

function guessContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.pdf':  return 'application/pdf';
    case '.png':  return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.tif':
    case '.tiff': return 'image/tiff';
    case '.heic': return 'image/heic';
    default:      return 'application/octet-stream';
  }
}

async function safeRename(oldPath, newPath) {
  try {
    await fs.rename(oldPath, newPath);
  } catch (err) {
    if (err.code === 'EXDEV') {
      await fs.copyFile(oldPath, newPath);
      await fs.unlink(oldPath);
    } else {
      throw err;
    }
  }
}

async function getUniqueDest(dir, filename) {
  let dest = path.join(dir, filename);
  if (!fssync.existsSync(dest)) return dest;
  const { name, ext } = path.parse(filename);
  let i = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = path.join(dir, `${name}-${i}${ext}`);
    if (!fssync.existsSync(candidate)) return candidate;
    i++;
  }
}

// ────────────────────────────────────────────────────────────
/** Local “storage” (mirrors your OneDrive+csvDrive API shape) */
// ────────────────────────────────────────────────────────────
async function getGraphClient() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  return { kind: 'local', root: OUTPUT_DIR };
}

async function ensureYearMonthFolder(_client, invoiceDate) {
  const d = new Date(invoiceDate);
  if (Number.isNaN(d.getTime())) throw new Error(`Bad invoice_date: ${invoiceDate}`);
  const year = String(d.getFullYear());
  const month = String(d.getMonth() + 1).padStart(2, '0');
  // Your OneDrive code uses "YYYY.MM"
  const folderPath = path.join(OUTPUT_DIR, `${year}.${month}`);
  if (!fssync.existsSync(folderPath)) await fs.mkdir(folderPath, { recursive: true });
  return folderPath; // acts like folderId
}

async function uploadFile(_client, folderId, filename, buffer, mime = 'application/octet-stream') {
  const dest = path.join(folderId, filename);
  await fs.writeFile(dest, buffer);
  return { path: dest, mime };
}

async function ensureCsvFile(_graph, folderId) {
  const csvPath = path.join(folderId, 'invoices.csv');
  if (!fssync.existsSync(csvPath)) {
    const header = [
      ['Timestamp', 'Invoice Date', 'Seller', 'Total', 'Tax', 'Payment Method']
    ].map(cols => cols.join(',')).join('\n') + '\n';
    await fs.writeFile(csvPath, header, 'utf8');
  }
  return csvPath; // acts as fileId
}

async function appendCsvRow(_graph, fileId, row) {
  const line = row.map(csvEscape).join(',') + '\n';
  await fs.appendFile(fileId, line, 'utf8');
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ────────────────────────────────────────────────────────────
// AI extraction helpers (copying your logic)
// ────────────────────────────────────────────────────────────
function resolveOpenAI(client) {
  return client ?? openai;
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

async function extractFromImage(buffer, openaiClient, contentType = 'image/png') {
  if (REQUIRE_AI && !process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY required for image extraction');
  }
  const base64 = buffer.toString('base64');

  const response = await openaiClient.chat.completions.create({
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
  const mod = await import('pdf-parse'); // npm i pdf-parse
  const pdfParse = mod.default || mod;
  const result = await pdfParse(buffer);
  return result.text || '';
}

async function extractFromPdf(buffer, openaiClient) {
  let text = '';
  if (process.env.PDF_EXTRACT_ENDPOINT) {
    const res = await fetch(process.env.PDF_EXTRACT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: buffer
    });
    if (!res.ok) {
      throw new Error(`PDF extractor failed: ${res.status} ${res.statusText}`);
    }
    text = await res.text();
  } else {
    console.log('ℹ️ No PDF_EXTRACT_ENDPOINT set — parsing PDF locally.');
    text = await parsePdfLocally(buffer);
    if (!text.trim()) throw new Error('Local PDF parse produced no text');
  }

  if (REQUIRE_AI && !process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY required for PDF field extraction');
  }

  const response = await openaiClient.chat.completions.create({
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

// ────────────────────────────────────────────────────────────
// The processor (same signature & flow as your invoiceProcessor.processAttachment)
// ────────────────────────────────────────────────────────────
async function processAttachment({ buffer, filename, contentType }, openaiClient) {
  const ai = resolveOpenAI(openaiClient);

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

    // Local "storage" in place of OneDrive
    const client = await getGraphClient();
    const folderId = await ensureYearMonthFolder(client, data.invoice_date);
    await uploadFile(client, folderId, filename, buffer);
    const csvId = await ensureCsvFile(client, folderId);
    await appendCsvRow(client, csvId, [
      new Date().toISOString(),
      data.invoice_date,
      data.seller,
      data.total,
      data.tax,
      data.payment_method
    ]);

    console.log(`✅ Stored locally in: ${folderId} | file: ${filename}`);
    return { ok: true, filename, data, folder: folderId };
  } catch (err) {
    console.error(`❌ ${filename} FULL ERROR:`, err);
    return { ok: false, filename, error: err.message };
  }
}

// ────────────────────────────────────────────────────────────
// Watcher (mirrors your scripts/watch-attachments.js behavior)
// ────────────────────────────────────────────────────────────
async function handle(filePath) {
  // Give the OS some time to finish writing the file
  await new Promise(r => setTimeout(r, 600));

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size === 0) return;
  } catch {
    return;
  }

  const filename = path.basename(filePath);
  const contentType = guessContentType(filename);

  try {
    const buffer = await fs.readFile(filePath);

    const result = await processAttachment({ buffer, filename, contentType }, openai);
    if (!result?.ok) throw new Error(result?.error || 'Processor reported failure');

    const dest = await getUniqueDest(PROCESSED_DIR, filename);
    await safeRename(filePath, dest);
    console.log('✔ processed', filename);
  } catch (err) {
    console.error('✖ failed', filename, err?.message || err);
    try {
      const dest = await getUniqueDest(FAILED_DIR, filename);
      await safeRename(filePath, dest);
    } catch {}
  }
}

async function main() {
  await ensureDirs();

  // Process any existing files on startup (top-level only)
  for (const f of fssync.readdirSync(ATTACHMENTS_DIR)) {
    const full = path.join(ATTACHMENTS_DIR, f);
    if (fssync.statSync(full).isFile() && isFinalInvoice(f)) handle(full);
  }

  const watcher = chokidar.watch(ATTACHMENTS_DIR, {
    persistent: true,
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 120 }
  });

  watcher.on('add', fp => {
    if (isFinalInvoice(path.basename(fp))) handle(fp);
  });
  watcher.on('error', e => console.error('Watcher error:', e));

  console.log('Watching:', ATTACHMENTS_DIR);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
