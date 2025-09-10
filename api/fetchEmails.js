/**
 * Email Retrieval and Processing Service
 * 
 * Fetches and processes email attachments from a specified sender,
 * extracts invoice data, and sends notifications.
 */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { google } from 'googleapis';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { OpenAI } from 'openai';
import { processAttachment } from '../lib/invoiceProcessor.js';
import twilio from 'twilio';
import logger from '../utils/logger.js'; // Create a structured logging module

// Load environment variables
dotenv.config();

// Constants
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ATTACHMENTS_DIR = join(__dirname, 'attachments');
const EMAIL_FETCH_HOURS = 24;
const PROCESSING_DELAY_MS = 1000;

/**
 * Initialize API clients and configuration
 */
const initializeClients = () => {
  // Initialize Twilio client
  const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN ? 
    twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN) : null;
    
  // Initialize Gmail OAuth client
  const oAuth2Client = new google.auth.OAuth2(
    process.env.WEB_CLIENT_ID,
    process.env.WEB_CLIENT_SECRET,
    process.env.WEB_REDIRECT_URIS
  );
  
  // Set credentials from environment
  oAuth2Client.setCredentials({
    refresh_token: process.env.WEB_REFRESH_TOKEN
  });
  
  // Initialize Gmail API
  const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
  
  // Initialize OpenAI API
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  
  return { twilioClient, gmail, openai };
};

/**
 * Send WhatsApp notification with processed filenames
 * 
 * @param {string[]} filenames - List of processed file names
 * @param {Object} twilioClient - Initialized Twilio client
 * @returns {Promise<void>}
 */
async function sendWhatsAppNotification(filenames = [], twilioClient) {
  if (!twilioClient || filenames.length === 0) {
    logger.debug('WhatsApp notification skipped: missing client or no files processed');
    return;
  }
  
  const recipient = process.env.TWILIO_REPLY_TO;
  const sender = process.env.TWILIO_WHATSAPP_NUMBER;

  if (!recipient || !sender) {
    logger.warn('WhatsApp notification skipped: missing configuration');
    return;
  }

  const message = `📬 The following invoice${filenames.length > 1 ? 's were' : ' was'} processed from your email:\n` +
    filenames.map(name => `• ${name}`).join('\n');

  try {
    await twilioClient.messages.create({
      from: `whatsapp:${sender}`,
      to: `whatsapp:${recipient}`,
      body: message,
    });
    logger.info('WhatsApp notification sent successfully');
  } catch (err) {
    logger.error('Failed to send WhatsApp notification', { error: err.message });
  }
}

/**
 * Extract email body from message parts
 * 
 * @param {Object[]} parts - Message parts from Gmail API
 * @returns {string|null} - Decoded email body or null if not found
 */
function extractBody(parts) {
  if (!parts) return null;

  for (const part of parts) {
    if (part.mimeType === 'text/plain' || part.mimeType === 'text/html') {
      return decodeBase64(part.body.data);
    }

    if (part.parts) {
      const nestedBody = extractBody(part.parts);
      if (nestedBody) return nestedBody;
    }
  }

  return null;
}

/**
 * Decode base64 encoded string to UTF-8
 * 
 * @param {string} data - Base64 encoded string
 * @returns {string} - Decoded UTF-8 string
 */
function decodeBase64(data) {
  return Buffer.from(data, 'base64').toString('utf-8');
}

/**
 * Ensure attachments directory exists
 * 
 * @returns {Promise<void>}
 */
async function ensureAttachmentsDir() {
  if (!existsSync(ATTACHMENTS_DIR)) {
    mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    logger.info(`Created attachments directory: ${ATTACHMENTS_DIR}`);
  }
}

/**
 * Get query date for email filtering
 * 
 * @param {number} hoursAgo - Hours to look back
 * @returns {string} - Formatted date string for Gmail query
 */
function getQueryDateString(hoursAgo) {
  const currentDate = new Date();
  currentDate.setHours(currentDate.getHours() - hoursAgo);
  return currentDate.toISOString().split('T')[0].replace(/-/g, '/');
}

/**
 * Process an email message and its attachments
 * 
 * @param {Object} message - Gmail message object
 * @param {Object} gmail - Gmail API client
 * @param {Object} openai - OpenAI API client
 * @returns {Promise<string[]>} - Successfully processed filenames
 */
async function processEmailMessage(message, gmail, openai) {
  const processedFiles = [];
  
  try {
    const msgRes = await gmail.users.messages.get({
      userId: 'me',
      id: message.id
    });

    const msg = msgRes.data;
    const headers = msg.payload.headers || [];
    const parts = msg.payload.parts || [];

    // Extract metadata
    const from = headers.find(header => header.name === 'From')?.value || 'Unknown';
    const subject = headers.find(header => header.name === 'Subject')?.value || 'No Subject';
    const date = headers.find(header => header.name === 'Date')?.value || '';

    logger.info('Processing email', { from, subject, date: new Date(date).toISOString() });

    // Extract attachments
    const attachments = parts.filter(part => part.filename && part.body?.attachmentId);

    if (attachments.length === 0) {
      logger.info('No attachments found in email', { subject });
      return processedFiles;
    }

    logger.info(`Found ${attachments.length} attachment(s)`, { subject });

    // Ensure attachments directory exists
    await ensureAttachmentsDir();

    // Process each attachment
    for (const attachment of attachments) {
      try {
        const attachmentData = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId: message.id,
          id: attachment.body.attachmentId
        });

        const buffer = Buffer.from(attachmentData.data.data, 'base64');
        const filePath = join(ATTACHMENTS_DIR, attachment.filename);
        await fs.writeFile(filePath, buffer);
        
        logger.info(`Saved attachment`, { filename: attachment.filename, size: buffer.length });

        // Process the attachment with OpenAI
        logger.info(`Processing with AI`, { filename: attachment.filename });
        
        const result = await processAttachment({
          buffer: buffer,
          filename: attachment.filename,
          contentType: attachment.mimeType,
        }, openai);

        if (result.ok) {
          logger.info(`Successfully processed`, { filename: attachment.filename });
          processedFiles.push(result.filename);
        } else {
          logger.warn(`Failed to process attachment`, { 
            filename: attachment.filename, 
            error: result.error 
          });
        }
      } catch (err) {
        logger.error('Attachment processing error', { 
          filename: attachment.filename, 
          error: err.message,
          stack: err.stack 
        });
      }
    }

    // Mark email as read
    await gmail.users.messages.modify({
      userId: 'me',
      id: message.id,
      resource: { removeLabelIds: ['UNREAD'] }
    });
    
    return processedFiles;
  } catch (err) {
    logger.error('Email processing error', { messageId: message.id, error: err.message });
    return processedFiles;
  }
}

/**
 * Main function to fetch and process emails
 * 
 * @returns {Promise<string[]>} - Successfully processed filenames
 */
export async function fetchEmails() {
  const { twilioClient, gmail, openai } = initializeClients();
  const successfulFilenames = [];
  const senderEmail = process.env.TARGET_SENDER_EMAIL || 'test.mateo@outlook.com';
  const formattedDate = getQueryDateString(EMAIL_FETCH_HOURS);

  try {
    logger.info('Fetching emails', { 
      sender: senderEmail, 
      timeframe: `${EMAIL_FETCH_HOURS} hours` 
    });

    // Fetch messages matching query
    const res = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 100,
      q: `from:${senderEmail} after:${formattedDate}`
    });

    const messages = res.data.messages || [];
    
    if (messages.length === 0) {
      logger.info('No new emails found in the specified time period');
      return [];
    }

    logger.info(`Found ${messages.length} messages to process`);

    // Process each message
    for (const message of messages) {
      const processedFiles = await processEmailMessage(message, gmail, openai);
      successfulFilenames.push(...processedFiles);
      
      // Add delay between processing emails to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, PROCESSING_DELAY_MS));
    }

    // Send notification if files were processed
    if (successfulFilenames.length > 0) {
      await sendWhatsAppNotification(successfulFilenames, twilioClient);
      logger.info('Email processing completed', { 
        totalProcessed: successfulFilenames.length,
        files: successfulFilenames
      });
    } else {
      logger.info('No files were successfully processed');
    }

    return successfulFilenames;
  } catch (err) {
    logger.error('Email fetching error', { error: err.message, stack: err.stack });
    throw err;
  }
}
