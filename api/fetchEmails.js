// pages/api/fetch-emails.js
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { OpenAI } from 'openai';
import { processAttachment } from '../lib/invoiceProcessor.js';
import twilio from 'twilio';

const imapConfig = {
  host: 'outlook.office365.com',
  port: 993,
  secure: true,
  auth: {
    user: process.env.OUTLOOK_EMAIL,
    pass: process.env.OUTLOOK_PASSWORD
  }
};

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function sendWhatsAppNotification(filenames = []) {
  if (!process.env.NOTIFY_WHATSAPP_EMAIL_TO || filenames.length === 0) return;

  const message = `📬 The following invoice${filenames.length > 1 ? 's were' : ' was'} processed from your email:\n` +
    filenames.map(name => `• ${name}`).join('\n');

  await twilioClient.messages.create({
    from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
    to: `whatsapp:${process.env.NOTIFY_WHATSAPP_EMAIL_TO}`,
    body: message
  });
}

async function fetchEmails() {
  const client = new ImapFlow(imapConfig);
  await client.connect();

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const successfulFilenames = [];

  try {
    await client.selectMailbox('INBOX');

    const messages = client.fetch('1:*', {
      envelope: true,
      source: true,
      bodyParts: ['BODY[]']
    });

    for await (const message of messages) {
      console.log('📧 Email received:', message.envelope.subject);

      const parsed = await simpleParser(message.source);

      // ✅ Pre-check to filter out irrelevant emails
      const hasAttachments = parsed.attachments?.length > 0;
      const hasInvoiceKeyword =
        parsed.subject?.toLowerCase().includes('invoice') ||
        parsed.text?.toLowerCase().includes('invoice') ||
        parsed.attachments?.some(att =>
          att.filename?.toLowerCase().includes('invoice')
        );

      if (!hasAttachments || !hasInvoiceKeyword) {
        console.log('🛑 Skipping email — likely not an invoice');
        continue;
      }

      for (const attachment of parsed.attachments) {
        const result = await processAttachment({
          buffer: attachment.content,
          filename: attachment.filename || 'attachment',
          contentType: attachment.contentType || 'application/octet-stream'
        }, openai);

        if (result.ok) successfulFilenames.push(result.filename);
      }
    }

    // ✅ Only send WhatsApp message if something was processed
    await sendWhatsAppNotification(successfulFilenames);

    return successfulFilenames;
  } catch (err) {
    console.error('❌ IMAP Fetch Error:', err);
    throw err;
  } finally {
    await client.logout();
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const processed = await fetchEmails();

    res.status(200).json({
      message: 'Emails processed',
      processed
    });
  } catch (err) {
    res.status(500).json({
      error: 'Failed to process emails',
      detail: err.message
    });
  }
}
