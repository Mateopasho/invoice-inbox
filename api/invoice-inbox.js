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
    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed');
      return;
    }

    const { from, numMedia = 0, media = [] } = req.body || {};

    if (!from) {
      res.status(400).json({ error: 'Missing "from" in request body' });
      return;
    }

    if (Number(numMedia) === 0 || media.length === 0) {
      res.json({ replyBody: 'No attachment found in the message.' });
      return;
    }

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

    const toProcess = validatedMedia.filter(m => m.ok);
    const preErrors = validatedMedia.filter(m => !m.ok);

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const processedResults = [];
    for (const mediaItem of toProcess) {
      const result = await processAttachment(mediaItem, openai);
      processedResults.push(result);
    }


    const results = [...preErrors, ...processedResults];
    const ok = results.filter(r => r.ok);
    const err = results.filter(r => !r.ok);

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

    if (!replyBody.trim()) {
      replyBody = 'No attachment found in the message.';
    }

    res.json({ replyBody: replyBody.trim() });
  } catch (fatal) {
    console.error('💥 Fatal error in handler:', fatal);
    res.status(500).json({
      replyBody:
        '⚠️ An unexpected error occurred while processing your message. Please try again later.'
    });
  }
}

async function processAttachment({ url, contentType, filename }, openai) {
  try {
    const { buffer, filename: realFilename } = await downloadFromTwilio(url);
    filename = sanitizeFilename(realFilename || filename);

    const data = contentType.includes('pdf')
      ? await extractFromPdf(buffer, openai)
      : await extractFromImage(buffer, openai);

    if (!data.invoice_date || !data.total) {
      throw new Error('Missing invoice_date or total in AI output');
    }

    const graph = await getGraphClient();

    // ✏️ Changed: use invoice_date to choose folder
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
    console.error(`❌ ${filename} MESSAGE   :`, err.message);
    return { ok: false, filename, error: err.message };
  }
}

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

  const buffer = Buffer.from(await res.arrayBuffer());

  const disposition = res.headers.get('content-disposition');
  let filename = url.split('/').pop(); // fallback

  if (disposition) {
    const match = disposition.match(/filename="(.+?)"/);
    if (match && match[1]) {
      filename = match[1];
    }
  }

  return { buffer, filename };
}

function sanitizeFilename(filename = '') {
  return filename
    .replace(/[\/\\:*?"<>|#%]/g, '-')  // replace illegal/sensitive characters
    .replace(/\s+/g, '_')              // replace spaces with _
    .slice(0, 100);                    // trim to avoid long path issues
}

async function extractFromImage(buffer, openai) {
  const base64 = buffer.toString('base64');
  const prompt = extractionPrompt();

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${base64}`
            }
          },
          {
            type: 'text',
            text: prompt
          }
        ]
      }
    ]
  });

  console.log('AI RAW IMAGE OUTPUT:', response.choices[0].message.content);

  const parsed = JSON.parse(stripFence(response.choices[0].message.content));

  if (parsed.total_amount !== undefined && parsed.total === undefined) {
    parsed.total = parsed.total_amount;
    delete parsed.total_amount;
  }

  console.log('AI PARSED IMAGE OUTPUT:', parsed);
  return parsed;
}

async function extractFromPdf(buffer, openai) {
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
  console.log('EXTRACTED PDF TEXT (first 300):', extractedText.slice(0, 300));

  const prompt = extractionPrompt();
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'user', content: prompt },
      { role: 'assistant', content: extractedText }
    ]
  });

  console.log('AI RAW PDF OUTPUT:', response.choices[0].message.content);

  const parsed = JSON.parse(stripFence(response.choices[0].message.content));

  if (parsed.total_amount !== undefined && parsed.total === undefined) {
    parsed.total = parsed.total_amount;
    delete parsed.total_amount;
  }

  console.log('AI PARSED PDF OUTPUT:', parsed);
  return parsed;
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

function stripFence(str = '') {
  str = str.replace(/[\u200B-\u200D\uFEFF]/g, '');
  const match = str.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (match) return match[1].trim();
  return str.trim();
}
