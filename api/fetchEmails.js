import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { google } from 'googleapis';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { OpenAI } from 'openai';
import { processAttachment } from '../lib/invoiceProcessor.js'; // Adjust path as needed
import twilio from 'twilio';

dotenv.config();

// Dynamically get the current directory (equivalent of __dirname in ES Modules)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Twilio setup
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

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

// Set up Gmail API OAuth2 client
const oAuth2Client = new google.auth.OAuth2(
  process.env.WEB_CLIENT_ID,
  process.env.WEB_CLIENT_SECRET,
  process.env.WEB_REDIRECT_URIS
);

// Set credentials (using refresh token stored in .env)
oAuth2Client.setCredentials({
  refresh_token: process.env.WEB_REFRESH_TOKEN
});

// Initialize Gmail API
const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

// Extract email body from parts
function extractBody(parts) {
  if (!parts) return null;

  for (const part of parts) {
    // Check if part is a text/plain or text/html
    if (part.mimeType === 'text/plain' || part.mimeType === 'text/html') {
      return decodeBase64(part.body.data);
    }

    // If the part is multipart, recurse into its child parts
    if (part.parts) {
      const nestedBody = extractBody(part.parts);
      if (nestedBody) return nestedBody;
    }
  }

  return null;
}

// Function to decode base64 email body data
function decodeBase64(data) {
  const buffer = Buffer.from(data, 'base64');
  return buffer.toString('utf-8');
}

// Main function to fetch and process emails
export async function fetchEmails() {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const successfulFilenames = [];

  // Define the sender email address you want to filter by
  const senderEmail = 'test.mateo@outlook.com'; // Replace with the actual sender's email

  // Get the current date and time
  const currentDate = new Date();

  // Subtract 24 hours
  currentDate.setHours(currentDate.getHours() - 2424);

  // Format the date as YYYY/MM/DD
  const date24HoursAgo = currentDate.toISOString().split('T')[0];  // This will give us 'YYYY-MM-DD'

  // Replace dashes with slashes to match Gmail's format
  const formattedDate = date24HoursAgo.replace(/-/g, '/');

  try {
    console.log('📥 Fetching emails from the last 24 hours from Gmail API...');

    // Fetch the latest emails from the specific sender in the last 24 hours
    const res = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 100,
      q: `from:${senderEmail} after:${formattedDate}` // Filter for emails from the specific sender in the last 24 hours
    });

    const messages = res.data.messages;
    if (!messages || messages.length === 0) {
      console.log('📭 No new emails found in the last 24 hours.');
      return [];
    }

    // Process each message
    for (const message of messages) {
      try {
        const msgRes = await gmail.users.messages.get({
          userId: 'me',
          id: message.id
        });

        const msg = msgRes.data;
        const headers = msg.payload.headers;
        const parts = msg.payload.parts;

        // Extract metadata: From, To, Subject, Date
        const from = headers.find(header => header.name === 'From').value;
        const subject = headers.find(header => header.name === 'Subject').value;
        const date = headers.find(header => header.name === 'Date').value;

        console.log('📬 Email Metadata:');
        console.log(`From: ${from}`);
        console.log(`Subject: ${subject}`);
        console.log(`Date: ${new Date(date).toString()}`);

        // Extract and print the email body (handle multipart parts)
        const body = extractBody(parts);
        console.log('\n📬 Full Body Structure:', body || 'No body content found');

        // Extract attachments
        const attachments = msg.payload.parts ? msg.payload.parts.filter(part => part.filename) : [];

        if (attachments.length === 0) {
          console.log('🛑 No attachments found.');
          continue;
        }

        console.log(`📎 Found ${attachments.length} attachment(s):`);
        attachments.forEach(attachment => {
          console.log(`📎 Attachment: ${attachment.filename}`);
          console.log(`MimeType: ${attachment.mimeType}`);  // Added for debugging
        });

        // Ensure the 'attachments' directory exists before saving the file
        const attachmentsDir = path.join(__dirname, 'attachments');
        if (!fs.existsSync(attachmentsDir)) {
          fs.mkdirSync(attachmentsDir); // Create the directory if it doesn't exist
        }

        // Process each attachment
        for (const attachment of attachments) {
          const attachmentData = await gmail.users.messages.attachments.get({
            userId: 'me',
            messageId: message.id,
            id: attachment.body.attachmentId
          });

          const buffer = Buffer.from(attachmentData.data.data, 'base64');
          const filePath = path.join(attachmentsDir, attachment.filename);
          fs.writeFileSync(filePath, buffer);
          console.log(`✅ Saved attachment: ${attachment.filename}`);

          // Process the attachment
          console.log(`📝 Sending to OpenAI for processing: ${attachment.filename}`);
          const result = await processAttachment({
            buffer: buffer,
            filename: attachment.filename,
            contentType: attachment.mimeType,
          }, openai);

          if (result.ok) {
            console.log(`✅ Successfully processed: ${attachment.filename}`);
            successfulFilenames.push(result.filename);
          } else {
            console.warn(`❌ Failed to process: ${attachment.filename}`, result.error);
          }
        }

        // Mark email as read
        await gmail.users.messages.modify({
          userId: 'me',
          id: message.id,
          resource: {
            removeLabelIds: ['UNREAD']
          }
        });

        await new Promise(resolve => setTimeout(resolve, 1000)); // 1-second delay

      } catch (err) {
        console.error('❌ Error processing message:', err.message);
      }
    }

    // Send WhatsApp notification with processed filenames
    if (successfulFilenames.length > 0) {
      await sendWhatsAppNotification(successfulFilenames);
      console.log('✅ Done. Processed files:', successfulFilenames);
    } else {
      console.log('📭 No files were processed.');
    }

    return successfulFilenames;
  } catch (err) {
    console.error('❌ Error fetching emails:', err.message);
    throw err;
  }
}
