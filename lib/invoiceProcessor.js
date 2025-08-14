// lib/invoiceProcessor.js
import fetch from 'node-fetch';
import { OpenAI } from 'openai';
import {
  getGraphClient,
  ensureYearMonthFolder,
  uploadFile
} from './onedrive.js';
import { ensureCsvFile, appendCsvRow } from './csvDrive.js';

function resolveOpenAI(client) {
  return client ?? new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

export async function processAttachment({ buffer, filename, contentType }, openai) {
  const ai = resolveOpenAI(openai);

  try {
    // Sanitize filename to remove invalid characters
    filename = sanitizeFilename(filename);

    let data;
    // Check if it's a PDF or image and call the appropriate function
    if (contentType.includes('pdf')) {
      console.log('📄 Processing PDF file...');
      data = await extractFromPdf(buffer, ai); // Handle PDF processing
    } else if (contentType.startsWith('image/')) {
      console.log('🖼️ Processing Image file...');
      // Pass through the real MIME (png/jpeg/webp/tiff/heic, etc.)
      data = await extractFromImage(buffer, ai, contentType);
    } else {
      throw new Error(`Unsupported content type: ${contentType}`);
    }

    // Check if the extracted data contains necessary fields
    if (!data.invoice_date || !data.total) {
      throw new Error('Missing invoice_date or total in AI output');
    }

    // Upload the file to OneDrive
    const graph = await getGraphClient();
    const folderId = await ensureYearMonthFolder(graph, data.invoice_date);
    await uploadFile(graph, folderId, filename, buffer);

    // Ensure a CSV file exists, then append data to it
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

// Sanitize the filename to remove invalid characters
function sanitizeFilename(filename = '') {
  return filename
    .replace(/[\/\\:*?"<>|#%]/g, '-')
    .replace(/\s+/g, '_')
    .slice(0, 100);
}

// Prompt for extracting the relevant information from the file
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

// Helper to remove unnecessary fence characters from OpenAI response
function stripFence(str = '') {
  str = str.replace(/[\u200B-\u200D\uFEFF]/g, '');
  const match = str.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (match) return match[1].trim();
  return str.trim();
}

// Extract data from an image attachment
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
            // Use the actual MIME so JPEG/HEIC/etc. are labeled correctly
            image_url: { url: `data:${contentType};base64,${base64}` }
          },
          {
            type: 'text',
            text: extractionPrompt()
          }
        ]
      }
    ]
  });

  // Parse the AI output and handle any discrepancies in the keys
  const parsed = JSON.parse(stripFence(response.choices[0].message.content));
  if (parsed.total_amount !== undefined && parsed.total === undefined) {
    parsed.total = parsed.total_amount;
    delete parsed.total_amount;
  }

  return parsed;
}

// Extract data from a PDF attachment
async function extractFromPdf(buffer, openai) {
  // If the PDF is password-protected or encrypted, you need to handle that
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
