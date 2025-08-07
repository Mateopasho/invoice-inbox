import { google } from 'googleapis';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

// Load environment variables from .env file
dotenv.config();

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

async function getEmails() {
  try {
    // Fetch the latest 5 threads
    const res = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 5,
      q: 'is:unread' // Optional: filter by unread emails, can be adjusted
    });

    const messages = res.data.messages;
    if (!messages || messages.length === 0) {
      console.log('No emails found!');
      return;
    }

    // Process each message
    for (const message of messages) {
      const msgRes = await gmail.users.messages.get({
        userId: 'me',
        id: message.id
      });

      const msg = msgRes.data;
      const headers = msg.payload.headers;
      const parts = msg.payload.parts;

      // Extract metadata: From, To, Subject, Date
      const from = headers.find(header => header.name === 'From').value;
      const to = headers.find(header => header.name === 'To').value;
      const subject = headers.find(header => header.name === 'Subject').value;
      const date = headers.find(header => header.name === 'Date').value;

      // Print Email Metadata
      console.log('\n=====================================');
      console.log('📬 Email Metadata:');
      console.log(`From: ${from}`);
      console.log(`To: ${to}`);
      console.log(`Subject: ${subject}`);
      console.log(`Date: ${new Date(date).toString()}`);

      // Extract and print the email body (handle multipart parts)
      const body = extractBody(parts);
      console.log('\n📬 Full Body Structure:');
      console.log(body || 'No body content found');

      // Check if there are attachments
      if (parts) {
        let attachmentCount = 0;
        for (const part of parts) {
          if (part.filename && part.body.attachmentId) {
            const attachment = await gmail.users.messages.attachments.get({
              userId: 'me',
              messageId: message.id,
              id: part.body.attachmentId
            });

            // Save the attachment (e.g., as a PDF or image)
            const attachmentData = attachment.data;
            const __dirname = new URL('.', import.meta.url).pathname; // Fix for ES Modules
            const filePath = path.join(__dirname, part.filename);
            fs.writeFileSync(filePath, attachmentData.data, 'base64');
            console.log(`🗂️ Attachment saved: ${filePath}`);
            attachmentCount++;
          }
        }

        if (attachmentCount === 0) {
          console.log('📂 No attachments found.');
        }
      }

      // Print a line to separate emails
      console.log('\n=====================================\n');
    }
  } catch (error) {
    console.error('Error fetching emails:', error);
  }
}

// Function to extract the body from email parts
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

// Call the function to get emails
getEmails();
