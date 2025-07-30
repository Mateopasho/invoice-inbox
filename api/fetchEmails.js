import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { processAttachment, extractFromPdf, extractFromImage } from '../../lib/invoiceProcessor';  // Import the relevant functions

// Set up IMAP connection to Outlook
const imapConfig = {
  host: 'outlook.office365.com',
  port: 993,
  secure: true,
  auth: {
    user: process.env.OUTLOOK_EMAIL,   // Outlook email
    pass: process.env.OUTLOOK_PASSWORD  // Outlook app password or OAuth token
  }
};

async function fetchEmails() {
  const client = new ImapFlow(imapConfig);
  
  await client.connect();

  try {
    // Open inbox folder
    await client.selectMailbox('INBOX');

    // Fetch all emails
    const messages = client.fetch('1:*', { attributes: ['ENVELOPE', 'BODY[]'] });

    for await (const message of messages) {
      console.log('📧 Email received:', message.envelope.subject);

      // Parse the email content
      const parsed = await simpleParser(message.body);

      // Process attachments if found
      if (parsed.attachments && parsed.attachments.length > 0) {
        for (const attachment of parsed.attachments) {
          await processAttachment(attachment);  // Process the attachment (PDF/image)
        }
      }
    }

  } catch (err) {
    console.error('IMAP Error:', err);
  } finally {
    await client.logout();
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      await fetchEmails();  // Fetch emails and process
      res.status(200).json({ message: 'Emails processed successfully' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch emails', details: err.message });
    }
  } else {
    res.status(405).json({ error: 'Method Not Allowed' });
  }
}
