import { ImapFlow } from 'imapflow';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

// Function to get IMAP configuration
async function getImapConfig() {
  return {
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD, // Use App Password if 2FA is enabled
    },
    socketTimeout: 60000,
    connectionTimeout: 30000,
  };
}

// Function to connect to the IMAP server with retries
async function connectWithRetry(client, retries = 5, delay = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await client.connect();
      console.log('📥 Successfully connected to IMAP');
      return;
    } catch (error) {
      console.error(`❌ Attempt ${attempt} failed:`, error.message);
      if (attempt < retries) {
        console.log(`⏳ Retrying in ${delay / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw new Error('Exceeded maximum retry attempts');
      }
    }
  }
}

// Function to download attachments
async function downloadAttachment(client, uid, partId, fileName) {
  try {
    const { meta, content } = await client.download(uid, partId);
    const filePath = path.join(__dirname, fileName);
    const writeStream = fs.createWriteStream(filePath);

    content.pipe(writeStream);
    writeStream.on('finish', () => {
      console.log(`📝 Attachment saved to ${filePath}`);
    });
    return filePath; // Return the file path of the downloaded attachment
  } catch (err) {
    console.error('❌ Error downloading attachment:', err.message);
    return null;
  }
}

// Function to fetch all email parts (text, HTML, attachments, etc.)
async function fetchAllEmailParts(client, uid) {
  const message = await client.fetchOne(uid, {
    envelope: true,
    bodyStructure: true, // Fetch body structure to inspect all parts
  }).catch(err => {
    console.error(`❌ Error fetching UID ${uid}:`, err);
    return null;
  });

  if (!message || !message.bodyStructure) {
    console.log('❌ Could not fetch the email or missing body structure');
    return null;
  }

  // Log the email metadata
  console.log("📬 Email Metadata:");
  console.log(`From: ${message.envelope.from[0].address}`);
  console.log(`To: ${message.envelope.to[0].address}`);
  console.log(`Subject: ${message.envelope.subject}`);
  console.log(`Date: ${message.envelope.date}`);

  // Recursively fetch all parts
  const parts = message.bodyStructure.parts || [];
  let allParts = [];

  for (let part of parts) {
    if (part.parts) {
      // Recursively handle nested parts
      allParts = allParts.concat(await fetchAllEmailParts(client, uid)); 
    } else {
      allParts.push(part);
    }
  }

  // Log full body structure for inspection
  console.log("📬 Full Body Structure:", JSON.stringify(message.bodyStructure, null, 2));

  return allParts;
}

// Function to print email body
async function printEmailBody(allParts) {
  for (let part of allParts) {
    if (part.type === 'text/plain' || part.type === 'text/html') {
      const encoding = part.encoding === 'base64' ? 'base64' : 'quoted-printable';
      const bodyContent = await decodeBody(part, encoding);
      console.log(`\n📬 Body Content (${part.type}):\n`);
      console.log(bodyContent);
    }
  }
}

// Function to decode body based on encoding
async function decodeBody(part, encoding) {
  const contentBuffer = Buffer.from(part.body, encoding); // Decode based on encoding type
  return contentBuffer.toString('utf8'); // Decode the buffer to string (assuming UTF-8)
}

// Function to fetch and process emails and attachments
export async function fetchEmails() {
  const client = new ImapFlow(await getImapConfig());
  const processedFiles = [];

  try {
    console.log('📥 Connecting to IMAP...');
    await connectWithRetry(client);

    console.log('📂 Opening INBOX...');
    await client.mailboxOpen('INBOX');

    const searchResult = await client.search({ seen: false });
    console.log('📩 Unread emails found:', searchResult.length);

    if (searchResult.length === 0) {
      console.log('📭 No unread messages found.');
      return processedFiles; // Return the empty array if no unread emails
    }

    for (let uid of searchResult) {
      console.log(`📬 Fetching email UID: ${uid}`);

      // Fetch all available body parts and metadata
      const allParts = await fetchAllEmailParts(client, uid);

      if (allParts.length > 0) {
        console.log('📝 Raw email body parts:');

        // Print the body content of the email (plain text or HTML)
        await printEmailBody(allParts);

        // Check for attachments and download them
        for (let part of allParts) {
          if (part.disposition && part.disposition.type === 'ATTACHMENT') {
            const fileName = part.disposition.params.filename;
            const partId = `${part.partId}`;
            console.log(`📎 Found attachment: ${fileName}`);
            const filePath = await downloadAttachment(client, uid, partId, fileName);
            if (filePath) {
              processedFiles.push(filePath); // Add the downloaded file path to the result array
            }
          }
        }
      } else {
        console.log('🛑 No email parts found');
      }
    }
  } catch (err) {
    console.error('❌ IMAP Fetch Error:', err.message);
  } finally {
    try {
      await client.logout();
    } catch (err) {
      console.error('❌ Logout error:', err.message);
    }
  }

  return processedFiles; // Return the list of processed files
}

// Run the function to fetch and process emails with attachments
fetchEmails();
