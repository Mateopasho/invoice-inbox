#!/usr/bin/env node

import chokidar from 'chokidar';
import path from 'path';
import fs from 'fs/promises';
import fssync from 'fs';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { OpenAI } from 'openai';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const pdfParse = require('pdf-parse');

dotenv.config();

const DEFAULT_ATTACHMENTS_DIR = path.join('api', 'attachments');
const ATTACHMENTS_DIR = path.resolve(process.env.ATTACHMENTS_DIR ?? DEFAULT_ATTACHMENTS_DIR);
const PROCESSED_DIR = path.join(ATTACHMENTS_DIR, 'processed');
const FAILED_DIR = path.join(ATTACHMENTS_DIR, 'failed');

const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR ?? 'local_out');
const REQUIRE_AI = true;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
  while (true) {
    const candidate = path.join(dir, `${name}-${i}${ext}`);
    if (!fssync.existsSync(candidate)) return candidate;
    i++;
  }
}

async function getGraphClient() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  return { kind: 'local', root: OUTPUT_DIR };
}

async function ensureYearMonthFolder(_client, invoiceDate) {
  const d = new Date(invoiceDate);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid invoice_date: ${invoiceDate}`);
  const year = String(d.getFullYear());
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const folderPath = path.join(OUTPUT_DIR, `${year}.${month}`);
  if (!fssync.existsSync(folderPath)) await fs.mkdir(folderPath, { recursive: true });
  return folderPath;
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
  return csvPath;
}

async function appendCsvRow(_graph, fileId, row) {
  const line = row.map(csvEscape).join(',') + '\n';
  await fs.appendFile(fileId, line, 'utf8');
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

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
    throw new Error('Authentication error: OPENAI_API_KEY is required for image extraction');
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
  console.log('INFO: Received buffer:', buffer?.constructor?.name, buffer?.length);
  if (!(buffer instanceof Buffer) || buffer.length === 0) {
    throw new Error('Invalid input: Empty or invalid buffer provided to PDF parser');
  }

  try {
    const result = await pdfParse(buffer);
    return result.text || '';
  } catch (e1) {
    try {
      const result = await pdfParse({ data: buffer });
      return result.text || '';
    } catch (e2) {
      e1.message = `PDF parsing error: ${e1.message}`;
      throw e1;
    }
  }
}

async function extractFromPdf(buffer, openaiClient) {
  let text = '';
  const endpoint = process.env.PDF_EXTRACT_ENDPOINT;
  if (endpoint && endpoint.trim()) {
    const res = await fetch(endpoint.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: buffer
    });
    if (!res.ok) {
      throw new Error(`PDF extraction service error: ${res.status} ${res.statusText}`);
    }
    text = await res.text();
  } else {
    console.log('INFO: PDF_EXTRACT_ENDPOINT not configured. Using local PDF parsing.');
    text = await parsePdfLocally(buffer);
    if (!text.trim()) throw new Error('PDF parsing error: No text extracted from document');
  }

  if (REQUIRE_AI && !process.env.OPENAI_API_KEY) {
    throw new Error('Authentication error: OPENAI_API_KEY is required for PDF field extraction');
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

async function processAttachment({ buffer, filename, contentType }, openaiClient) {
  const ai = resolveOpenAI(openaiClient);

  try {
    filename = sanitizeFilename(filename);

    let data;
    if (contentType.includes('pdf')) {
      console.log('INFO: Processing PDF document...');
      data = await extractFromPdf(buffer, ai);
    } else if (contentType.startsWith('image/')) {
      console.log('INFO: Processing image document...');
      data = await extractFromImage(buffer, ai, contentType);
    } else {
      throw new Error(`Unsupported document format: ${contentType}`);
    }

    if (!data.invoice_date || !data.total) {
      throw new Error('Validation error: Required fields missing in extraction results');
    }

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

    console.log(`SUCCESS: Document stored in: ${folderId} | file: ${filename}`);
    return { ok: true, filename, data, folder: folderId };
  } catch (err) {
    console.error(`ERROR: ${filename} processing failed:`, err);
    return { ok: false, filename, error: err.message };
  }
}

async function handle(filePath) {
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
    if (!result?.ok) throw new Error(result?.error || 'Processing failure');

    const dest = await getUniqueDest(PROCESSED_DIR, filename);
    await safeRename(filePath, dest);
    console.log('SUCCESS: Document processed:', filename);
  } catch (err) {
    console.error('ERROR: Processing failed:', filename, err?.message || err);
    try {
      const dest = await getUniqueDest(FAILED_DIR, filename);
      await safeRename(filePath, dest);
    } catch {}
  }
}

async function main() {
  await ensureDirs();

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
  watcher.on('error', e => console.error('Monitoring error:', e));

  console.log('INFO: Directory monitoring active on:', ATTACHMENTS_DIR);
}

main().catch(e => {
  console.error('FATAL ERROR:', e);
  process.exit(1);
});
