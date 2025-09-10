import fetch from 'node-fetch';
import twilio from 'twilio';

export const config = {
  api: {
    bodyParser: false, // Twilio webhook uses form-urlencoded format
  },
};

/**
 * Validates if the provided string is a valid international phone number
 * @param {string} number - Phone number to validate
 * @return {boolean} Validation result
 */
function isValidWhatsAppNumber(number) {
  return typeof number === 'string' && /^\+?[1-9]\d{6,14}$/.test(number);
}

/**
 * Retrieves a safe number for message replies
 * @param {string} from - Original sender number
 * @return {string} Validated phone number or fallback
 */
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

    // Process the incoming request body
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
      await sendTwilioReply(replyTo, 'No attachment found in your message. Please attach the document and try again.');
      return res.status(200).end();
    }

    const auth = Buffer.from(
      `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
    ).toString('base64');

    // Retrieve media metadata from Twilio API
    const mediaRes = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${AccountSid}/Messages/${MessageSid}/Media.json`,
      {
        headers: { Authorization: `Basic ${auth}` },
      }
    );

    if (!mediaRes.ok) {
      console.error('ERROR: Failed to fetch media metadata:', await mediaRes.text());
      throw new Error(`Twilio media fetch failed: ${mediaRes.status}`);
    }

    const mediaJson = await mediaRes.json();
    const mediaList = mediaJson.media_list || [];

    const media = [];

    // Process each media item
    for (let i = 0; i < mediaList.length; i++) {
      const m = mediaList[i];
      const mediaUrl = m.url || `https://api.twilio.com${m.uri.replace('.json', '')}`;

      // Attempt to retrieve file metadata
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
        console.warn('WARNING: Failed to fetch headers for media item:', headErr.message);
      }

      media.push({
        url: mediaUrl,
        contentType,
        filename,
      });
    }

    // Forward metadata to invoice processing service
    const invoiceRes = await fetch(`${process.env.PUBLIC_URL}/api/invoice-inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: From, numMedia, media }),
    });

    let replyBody = 'An unexpected error occurred while processing your document.';

    if (invoiceRes.ok) {
      try {
        const result = await invoiceRes.json();
        replyBody = result.replyBody?.trim() || 'Your document has been successfully processed.';
      } catch (err) {
        console.error('ERROR: Failed to parse response from invoice processor:', err);
        replyBody = 'Unable to process the response from document processing service.';
      }
    } else {
      const errorText = await invoiceRes.text();
      console.error(`ERROR: Invoice processor failed (${invoiceRes.status}):`, errorText);
      replyBody = 'The document processing service encountered an error. Please try again later.';
    }

    await sendTwilioReply(replyTo, replyBody);
    res.status(200).end();
  } catch (err) {
    console.error('ERROR: Twilio webhook processing failed:', err);
    const fallbackTo = getSafeReplyNumber(req.body?.From || '');
    try {
      await sendTwilioReply(
        fallbackTo,
        'We encountered an error processing your message. Please try again later or contact support if the issue persists.'
      );
    } catch (twilioErr) {
      console.error('ERROR: Failed to send error notification message:', twilioErr);
    }
    res.status(500).send('Internal Server Error');
  }
}

/**
 * Sends a WhatsApp reply using Twilio API
 * @param {string} to - Recipient's phone number
 * @param {string} body - Message content
 * @return {Promise} Twilio message promise
 */
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
