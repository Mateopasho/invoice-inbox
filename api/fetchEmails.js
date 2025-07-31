import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { OpenAI } from 'openai';
import { processAttachment } from '../lib/invoiceProcessor.js'; // Adjust path as needed
import twilio from 'twilio';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

// Twilio setup
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const logError = true; // Toggle this to true/false to control error logging

// Send WhatsApp notifications
async function sendWhatsAppNotification(filenames = []) {
  const recipient = process.env.TWILIO_REPLY_TO;
  const sender = process.env.TWILIO_WHATSAPP_NUMBER;

  if (!recipient || !sender || filenames.length === 0) return;

  const message = `📬 The following invoice${filenames.length > 1 ? 's were' : ' was'} processed from your email:\n` +
    filenames.map(name => `• ${name}`).join('\n');

  try {
    await twilioClient.messages.create({
      from: `whatsapp:${sender}`,
      to: `whatsapp:${recipient}`,
      body: message,
    });
  } catch (err) {
    console.error('❌ WhatsApp Notification Error:', err.message);
  }
}

// Get IMAP config with the fix for self-signed certificates
async function getImapConfig() {
  return {
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD // Use an App Password if 2FA is enabled
    },
    socketTimeout: 120000, // Increased timeout for socket
    connectionTimeout: 60000, // Increased timeout for connection
    tls: {
      rejectUnauthorized: false // Disable certificate validation (unsafe for production)
    }
  };
}

// Connect with retry logic
async function connectWithRetry(client, retries = 5, delay = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await client.connect();
      if (logError) console.log('📥 Successfully connected to IMAP');
      return;
    } catch (error) {
      if (logError) console.error(`❌ Attempt ${attempt} failed:`, error.message);
      if (attempt < retries) {
        if (logError) console.log(`⏳ Retrying in ${delay / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw new Error('Exceeded maximum retry attempts');
      }
    }
  }
}

// Safe fetch with retry for individual messages
async function safeFetchOne(client, uid) {
  try {
    const message = await client.fetchOne(uid, { envelope: true, source: true, bodyParts: ['BODY[]'] });
    return message;
  } catch (err) {
    if (logError) {
      console.error(`❌ Error fetching UID ${uid}:`, err.message);
      console.log('🔄 Attempting to reconnect...');
    }

    const newClient = new ImapFlow(await getImapConfig());
    await connectWithRetry(newClient);

    try {
      const message = await newClient.fetchOne(uid, { envelope: true, source: true, bodyParts: ['BODY[]'] });
      return message;
    } catch (reconnectErr) {
      if (logError) console.error(`❌ Error fetching UID ${uid} after reconnect:`, reconnectErr.message);
      return null;
    }
  }
}

// Save attachment to disk
function saveAttachment(attachment) {
  const filePath = path.join(__dirname, 'attachments', attachment.filename);
  fs.writeFileSync(filePath, attachment.content);
  if (logError) console.log(`✅ Saved attachment: ${attachment.filename}`);
}

// Main function to fetch and process emails
export async function fetchEmails() {
  const client = new ImapFlow(await getImapConfig());

  try {
    console.log('📥 Connecting to IMAP...');
    await connectWithRetry(client);

    console.log('📂 Opening INBOX...');
    await client.mailboxOpen('INBOX');

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const successfulFilenames = [];

    const searchResult = await client.search({ seen: false });
    console.log('📩 Unread emails found:', searchResult.length);

    if (searchResult.length === 0) {
      console.log('📭 No unread messages found.');
      return [];
    }

    const sortedEmails = searchResult.sort((a, b) => b - a);
    console.log('📩 Sorted emails by date (newest first):', sortedEmails);

    const limitedEmails = sortedEmails.slice(0, 10);
    console.log(`📩 Limiting to the latest 10 emails: ${limitedEmails.length}`);

    for (let i = 0; i < limitedEmails.length; i++) {
      const uid = limitedEmails[i];

      try {
        const message = await safeFetchOne(client, uid);
        if (!message) {
          console.log(`❌ Skipping UID ${uid} due to previous fetch error.`);
          continue;
        }

        console.log('📧 Email received:', message.envelope.subject);
        console.log('🔍 From:', message.envelope.from);
        console.log('🔍 Subject:', message.envelope.subject);

        const parsed = await simpleParser(message.source);
        const attachments = parsed.attachments || [];

        if (attachments.length === 0) {
          console.log('🛑 Skipping email — no attachments');
          continue;
        }

        console.log(`📎 Attachments found: ${attachments.length}`);
        attachments.forEach(attachment => {
          console.log(`📎 Attachment: ${attachment.filename}, Size: ${attachment.content.length} bytes`);
          saveAttachment(attachment);
        });

        for (const attachment of attachments) {
          if (attachment.content.length > 10 * 1024 * 1024) {
            console.warn(`⚠️ Skipping large attachment: ${attachment.filename}`);
            continue;
          }

          const result = await processAttachment({
            buffer: attachment.content,
            filename: attachment.filename || 'attachment',
            contentType: attachment.contentType || 'application/octet-stream',
          }, openai);

          if (result.ok) {
            console.log(`✅ Successfully processed: ${result.filename}`);
            successfulFilenames.push(result.filename);
          } else {
            console.warn(`❌ Failed to process: ${result.filename}`);
          }
        }

        await client.messageFlagsAdd(message.uid, ['\\Seen']);
      } catch (err) {
        console.error(`❌ Error processing UID ${uid}:`, err.message);
        continue;
      }

      await new Promise(resolve => setTimeout(resolve, 1000)); // 1-second delay
    }

    if (successfulFilenames.length === 0) {
      console.log('📭 No messages processed.');
    }

    await sendWhatsAppNotification(successfulFilenames);
    console.log('✅ Done. Processed files:', successfulFilenames);
    return successfulFilenames;
  } catch (err) {
    console.error('❌ IMAP Fetch Error:', err.message);
    throw err;
  } finally {
    try {
      await client.logout();
    } catch (err) {
      console.error('❌ Logout error:', err.message);
    }
  }
}
