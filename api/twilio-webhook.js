import fetch from 'node-fetch';
import twilio from 'twilio';

export const config = {
  api: {
    bodyParser: false, // Twilio sends application/x-www-form-urlencoded
  },
};

function isValidWhatsAppNumber(number) {
  return typeof number === 'string' && /^\+?[1-9]\d{6,14}$/.test(number);
}

function getSafeReplyNumber(from) {
  return isValidWhatsAppNumber(from)
    ? from
    : process.env.TWILIO_REPLY_TO;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed');
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyStr = Buffer.concat(chunks).toString('utf8');
    const params = new URLSearchParams(bodyStr);
    const data = Object.fromEntries(params.entries());

    const { MessageSid, From, NumMedia = '0', AccountSid } = data;
    const numMedia = parseInt(NumMedia, 10);

    if (!From || !MessageSid || !AccountSid) {
      return res.status(400).json({ error: 'Missing required Twilio fields' });
    }

    const replyTo = getSafeReplyNumber(From);

    if (numMedia === 0) {
      await sendTwilioReply(replyTo, '📎 No attachment found in your message.');
      return res.status(200).end();
    }

    const auth = Buffer.from(
      `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
    ).toString('base64');

    // Step 1: Fetch media list from Twilio
    const mediaRes = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${AccountSid}/Messages/${MessageSid}/Media.json`,
      {
        headers: { Authorization: `Basic ${auth}` },
      }
    );

    if (!mediaRes.ok) {
      console.error('❌ Failed to fetch media metadata:', await mediaRes.text());
      throw new Error(`Twilio media fetch failed: ${mediaRes.status}`);
    }

    const mediaJson = await mediaRes.json();
    const mediaList = mediaJson.media_list || [];

    const media = [];

    for (let i = 0; i < mediaList.length; i++) {
      const m = mediaList[i];
      const mediaUrl = m.url || `https://api.twilio.com${m.uri.replace('.json', '')}`;

      // Try to fetch headers for real filename
      let filename = `media_${i}`;
      let contentType = m.content_type || 'application/octet-stream';

      try {
        const headersRes = await fetch(mediaUrl, {
          method: 'HEAD',
          headers: { Authorization: `Basic ${auth}` },
        });

        const contentDisp = headersRes.headers.get('content-disposition') || '';
        const filenameMatch = contentDisp.match(/filename="([^"]+)"/);
        if (filenameMatch) {
          filename = filenameMatch[1];
        }

        const contentTypeHeader = headersRes.headers.get('content-type');
        if (contentTypeHeader) {
          contentType = contentTypeHeader;
        }
      } catch (headErr) {
        console.warn(`⚠️ Failed to fetch HEAD for media ${i}:`, headErr.message);
      }

      media.push({
        url: mediaUrl,
        contentType,
        filename,
      });
    }

    // Step 2: Forward metadata to invoice-inbox
    const invoiceRes = await fetch(`${process.env.PUBLIC_URL}/api/invoice-inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: From, numMedia, media }),
    });

    let replyBody = '⚠️ Unexpected error.';

    if (invoiceRes.ok) {
      try {
        const result = await invoiceRes.json();
        replyBody = result.replyBody?.trim() || '✅ Done.';
      } catch (err) {
        console.error('❌ Failed to parse JSON from invoice-inbox:', err);
        replyBody = '⚠️ Could not parse response from invoice processor.';
      }
    } else {
      const errorText = await invoiceRes.text();
      console.error(`❌ invoice-inbox failed (${invoiceRes.status}):`, errorText);
      replyBody = '⚠️ Invoice processor returned an error.';
    }

    await sendTwilioReply(replyTo, replyBody);
    res.status(200).end();
  } catch (err) {
    console.error('❌ Twilio webhook error:', err);
    const fallbackTo = getSafeReplyNumber(req.body?.From || '');
    try {
      await sendTwilioReply(
        fallbackTo,
        '⚠️ Error processing your message. Please try again later.'
      );
    } catch (twilioErr) {
      console.error('❌ Failed to send fallback reply:', twilioErr);
    }
    res.status(500).send('Internal Server Error');
  }
}

async function sendTwilioReply(to, body) {
  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  return client.messages.create({
    from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
    to: `whatsapp:${to}`,
    body,
  });
}
