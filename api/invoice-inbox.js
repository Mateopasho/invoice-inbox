// pages/api/invoice-inbox.js
import { OpenAI } from 'openai';
import { processAttachment } from '../lib/invoiceProcessor.js';

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
      const { url, contentType, filename } = mediaItem;

      const response = await fetch(url, {
        headers: {
          Authorization:
            'Basic ' +
            Buffer.from(
              `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
            ).toString('base64')
        }
      });

      if (!response.ok) {
        processedResults.push({
          ok: false,
          filename,
          error: `Download failed: ${response.status}`
        });
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());

      const result = await processAttachment({
        buffer,
        filename,
        contentType
      }, openai);

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
