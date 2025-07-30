import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { OpenAI } from 'openai';
import { processAttachment } from '../lib/invoiceProcessor.js';
import twilio from 'twilio';
import * as Sentry from '@sentry/node'; // Sentry error monitoring
import { ConfidentialClientApplication } from '@azure/msal-node'; // Azure MSAL for OAuth2

// Sentry Initialization
Sentry.init({ dsn: process.env.SENTRY_DSN });

// OAuth2 setup for Azure
const cca = new ConfidentialClientApplication({
  auth: {
    clientId: process.env.ONEDRIVE_CLIENT_ID, // Your existing env variable
    clientSecret: process.env.ONEDRIVE_CLIENT_SECRET, // Your existing env variable
    authority: `https://login.microsoftonline.com/${process.env.ONEDRIVE_TENANT_ID}`, // Your existing env variable
  },
});

// Function to fetch OAuth2 token
async function getAccessToken() {
  const tokenRequest = {
    scopes: [
      "https://graph.microsoft.com/.default",
      "Mail.Read",  // Default scope for accessing Microsoft Graph API
    ],
  };

  try {
    const response = await cca.acquireTokenByClientCredential(tokenRequest);
    console.log("✅ Access token fetched successfully");
    return response.accessToken; // Returning the access token for authentication
  } catch (error) {
    console.error("❌ Error fetching access token:", error);
    Sentry.captureException(error); // Log error to Sentry
    throw new Error('Failed to get access token');
  }
}

// IMAP config using OAuth2
async function getImapConfig() {
  const accessToken = await getAccessToken();
  console.log("Access Token:", accessToken); // Log token for debugging

  // Log token details (decoded JWT) for debugging
  try {
    const decodedToken = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64').toString());
    console.log("Decoded Token:", decodedToken);  // Log the decoded token to verify scopes
  } catch (error) {
    console.error("Failed to decode token:", error);
  }

  return {
    host: 'outlook.office365.com',
    port: 993,
    secure: true,
    auth: {
      type: 'XOAUTH2',
      user: process.env.OUTLOOK_EMAIL,  // Your Outlook email
      accessToken, // OAuth2 token
    },
  };
}

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID, // Your existing env variable
  process.env.TWILIO_AUTH_TOKEN // Your existing env variable
);

// Send WhatsApp Notification about processed invoices
async function sendWhatsAppNotification(filenames = []) {
  if (!process.env.NOTIFY_WHATSAPP_EMAIL_TO || filenames.length === 0) return;

  const message = `📬 The following invoice${filenames.length > 1 ? 's were' : ' was'} processed from your email:\n` +
    filenames.map(name => `• ${name}`).join('\n');

  try {
    await twilioClient.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`, // WhatsApp number to send from
      to: `whatsapp:${process.env.NOTIFY_WHATSAPP_EMAIL_TO}`, // Recipient's WhatsApp number
      body: message,
    });
  } catch (err) {
    console.error('❌ WhatsApp Notification Error:', err);
    Sentry.captureException(err); // Log error to Sentry
  }
}

// Function to fetch and process emails
async function fetchEmails() {
  const client = new ImapFlow(await getImapConfig());

  try {
    await client.connect();

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); // OpenAI API key
    const successfulFilenames = [];

    // Limit fetch to 100 messages at a time for rate-limiting
    const messages = client.fetch('1:100', {
      envelope: true,
      source: true,
      bodyParts: ['BODY[]'],
    });

    for await (const message of messages) {
      console.log('📧 Email received:', message.envelope.subject);

      const parsed = await simpleParser(message.source);

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
        // Check attachment size to avoid memory overload (e.g., limit to 10MB)
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
          console.log(`✅ Processed attachment: ${result.filename}`);
          successfulFilenames.push(result.filename);
        } else {
          console.warn(`⚠️ Failed to process attachment: ${result.filename}`);
        }
      }
    }

    // Send notification after successful processing
    await sendWhatsAppNotification(successfulFilenames);
    return successfulFilenames;
  } catch (err) {
    console.error('❌ IMAP Fetch Error:', err);
    Sentry.captureException(err); // Log error to Sentry
    throw err;
  } finally {
    try {
      await client.logout(); // Ensure to logout and close the IMAP connection
    } catch (err) {
      console.error('❌ IMAP Logout Error:', err);
    }
  }
}

// Cron handler for triggering email fetch
export default async function handler(req, res) {
  console.log('⏱️ Cron job triggered');

  // Verify the request method is GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Validate the cron job invocation via Authorization header
  const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;
  const receivedAuth = req.headers.authorization || '';

  if (receivedAuth !== expectedAuth) {
    console.warn('❌ Unauthorized cron invocation');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const processed = await fetchEmails();
    res.status(200).json({
      message: 'Emails processed successfully',
      processed,
    });
  } catch (err) {
    console.error('❌ Handler error:', err);
    Sentry.captureException(err); // Log error to Sentry
    res.status(500).json({
      error: 'Failed to process emails',
      detail: err.message,
    });
  }
}

// ────────────────────────────────────────────────────────────