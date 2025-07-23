import fetch from 'node-fetch';
import twilio from 'twilio';

export const config = {
  api: {
    bodyParser: false, // Twilio sends application/x-www-form-urlencoded
  },
};

// Validate E.164 format
function isValidWhatsAppNumber(number) {
  return typeof number === 'string' && /^\+?[1-9]\d{6,14}$/.test(number);
}

// Fallback to trusted number if invalid
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

    // Parse Twilio form body
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

    // Fetch media list from Twilio
    const auth = Buffer.from(
      `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
    ).toString('base64');

    const mediaRes = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${AccountSid}/Messages/${MessageSid}/Media.json`,
      {
        headers: {
          Authorization: `Basic ${auth}`,
        },
      }
    );

    if (!mediaRes.ok) {
      console.error('❌ Failed to fetch media metadata:', await mediaRes.text());
      throw new Error(`Twilio media fetch failed: ${mediaRes.status}`);
    }

    const mediaJson = await mediaRes.json();
    const mediaList = mediaJson.media_list || mediaJson.media || [];

    const media = mediaList.map((m, i) => {
      const fullUrl = m.url
        ? m.url
        : `https://api.twilio.com${m.uri.replace('.json', '')}`;
      return {
        url: fullUrl,
        contentType: m.content_type || m.contentType,
        filename: fullUrl.split('/').pop() || `media_${i}`,
      };
    });

    // Forward to invoice processor
    const invoiceRes = await fetch(
      `${process.env.PUBLIC_URL}/api/invoice-inbox`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: From,
          numMedia,
          media,
        }),
      }
    );

    const { replyBody } = await invoiceRes.json();

    const formattedReply = `✅ Processed ${numMedia} file(s)\n\n${
      media.map((m) => `• ${m.filename}`).join('\n')
    }\n\n${replyBody || ''}`;

    await sendTwilioReply(replyTo, formattedReply.trim());
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
