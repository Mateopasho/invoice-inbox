/**
 * Invoice Processing Module
 * Handles extraction of invoice data from attachments and storage management.
 * @module invoiceProcessor
 */

import { OpenAI } from 'openai';
import { createRequire } from 'module';
import {
  getGraphClient,
  ensureYearMonthFolder,
  uploadFile
} from './onedrive.js';
import { ensureCsvFile, appendCsvRow } from './csvDrive.js';

const require = createRequire(import.meta.url);

/**
 * Resolves OpenAI client instance
 * @param {OpenAI|null} client - Existing client or null
 * @returns {OpenAI} - OpenAI client instance
 */
function resolveOpenAI(client) {
  return client ?? new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

/**
 * Process document attachment and extract invoice data
 * @param {Object} attachment - The attachment object
 * @param {Buffer} attachment.buffer - File buffer
 * @param {string} attachment.filename - Original filename
 * @param {string} attachment.contentType - MIME type
 * @param {OpenAI} [openai] - Optional OpenAI client instance
 * @returns {Promise<Object>} Processing result
 */
export async function processAttachment({ buffer, filename, contentType }, openai) {
  const ai = resolveOpenAI(openai);

  try {
    filename = sanitizeFilename(filename);

    let data;
    if (contentType.includes('pdf')) {
      console.log('INFO: Processing PDF document');
      data = await extractFromPdf(buffer, ai);
    } else if (contentType.startsWith('image/')) {
      console.log('INFO: Processing image document');
      data = await extractFromImage(buffer, ai, contentType);
    } else {
      throw new Error(`Unsupported content type: ${contentType}`);
    }

    if (!data.invoice_date || !data.total) {
      throw new Error('Required invoice data missing: invoice_date or total amount');
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

    console.log(`SUCCESS: Document processed successfully. Filename: ${filename}`);
    return { ok: true, filename };
  } catch (err) {
    console.error(`ERROR: Processing failed for ${filename}. Details:`, err);
    return { ok: false, filename, error: err.message };
  }
}

/**
 * Sanitizes filename to ensure compatibility with storage systems
 * @param {string} filename - Original filename
 * @returns {string} Sanitized filename
 */
function sanitizeFilename(filename = '') {
  return filename
    .replace(/[\/\\:*?"<>|#%]/g, '-')
    .replace(/\s+/g, '_')
    .slice(0, 100);
}

/**
 * Returns the data extraction prompt for AI
 * @returns {string} Extraction prompt
 */
function extractionPrompt() {
  // Prompt content unchanged as it's already well-structured
  return `
You are an information extraction system. Your task is to analyze the provided text (which may be an invoice, receipt, or financial document) and return a JSON object containing the following fields:

- "invoice_date": The invoice issue date in strict ISO format (YYYY-MM-DD).  
  • If multiple dates appear, choose the one most likely to be the invoice issue date (not due date, not delivery date).  
  • If no date can be determined, return "".

- "seller": The entity issuing the invoice (company or individual).  
  • This is never "Timelessoft" (they are only processing invoices).  
  • Extract the seller's name exactly as written in the text.  
  • If no seller can be determined, return "".

- "total": The total invoice amount as a number with exactly two decimal places.  
  • Always extract the *final total payable amount* (including tax, if present).  
  • Represent only the numeric value (no currency symbols, no commas). Example: 1234.50.  
  • If no total can be determined, return "".

- "tax": The tax amount or percentage associated with the invoice.  
  • If both an amount and a percentage are present, return the amount in numeric form (two decimals).  
  • If only a percentage is available, return it as a string with "%" (e.g., "19%").  
  • If no tax is mentioned, return "".

- "payment_method": The method of payment (e.g., "Credit Card", "Bank Transfer", "Cash", "PayPal").  
  • If multiple are mentioned, pick the most relevant (the one actually used for this invoice, not just an option).  
  • If not specified, return "".

STRICT REQUIREMENTS:
1. Return ONLY a valid JSON object with the above keys, in exactly this format:
   {
     "invoice_date": "",
     "seller": "",
     "total": "",
     "tax": "",
     "payment_method": ""
   }

2. Do NOT include explanations, notes, markdown fences, or extra text — only the JSON.

3. All string values must be enclosed in double quotes ("").

4. If a value cannot be confidently extracted, use an empty string ("").

Example of a valid output:
{
  "invoice_date": "2025-09-10",
  "seller": "ACME GmbH",
  "total": "1250.75",
  "tax": "19%",
  "payment_method": "Bank Transfer"
}
`;
}

/**
 * Removes markdown code fences from string
 * @param {string} str - Input string
 * @returns {string} Cleaned string
 */
function stripFence(str = '') {
  str = str.replace(/[\u200B-\u200D\uFEFF]/g, '');
  const match = str.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (match) return match[1].trim();
  return str.trim();
}

/**
 * Extracts invoice data from image
 * @param {Buffer} buffer - Image buffer
 * @param {OpenAI} openai - OpenAI client
 * @param {string} contentType - Image MIME type
 * @returns {Promise<Object>} Extracted invoice data
 */
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

/**
 * Parses PDF document using local pdf-parse library
 * @param {Buffer} buffer - PDF file buffer
 * @returns {Promise<string>} Extracted text content
 */
async function parsePdfLocally(buffer) {
  console.log('INFO: Initiating local PDF parsing');
  if (!(buffer instanceof Buffer) || buffer.length === 0) {
    throw new Error('Invalid or empty buffer provided for PDF parsing');
  }

  const pdfParse = require('pdf-parse');
  const result = await pdfParse(buffer);
  return result.text || '';
}

/**
 * Extracts invoice data from PDF document
 * @param {Buffer} buffer - PDF buffer
 * @param {OpenAI} openai - OpenAI client
 * @returns {Promise<Object>} Extracted invoice data
 */
async function extractFromPdf(buffer, openai) {
  console.log('INFO: Parsing PDF content');
  const text = await parsePdfLocally(buffer);
  if (!text.trim()) throw new Error('PDF parsing yielded no extractable text content');

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
