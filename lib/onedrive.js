/**
 * @fileoverview Microsoft OneDrive integration module for document management.
 * @module lib/onedrive
 */

import { Client } from '@microsoft/microsoft-graph-client';
import {
  TokenCredentialAuthenticationProvider
} from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';
import { ClientSecretCredential } from '@azure/identity';
import 'isomorphic-fetch';

// Configuration constants
const USER_ID = process.env.ONEDRIVE_USER_ID;
const DRIVE_ROOT = `/users/${USER_ID}/drive`;
const DEFAULT_SCOPES = ['https://graph.microsoft.com/.default'];
const INVOICE_ROOT_PATH = 'Invoices';

/**
 * Initializes and returns an authenticated Microsoft Graph client.
 * @returns {Promise<import('@microsoft/microsoft-graph-client').Client>} Authenticated Graph client
 * @throws {Error} If authentication fails or required environment variables are missing
 */
export async function getGraphClient() {
  if (!process.env.ONEDRIVE_CLIENT_ID || !process.env.ONEDRIVE_CLIENT_SECRET) {
    throw new Error('Missing required OneDrive authentication credentials');
  }

  const credential = new ClientSecretCredential(
    process.env.ONEDRIVE_TENANT_ID || 'organizations',
    process.env.ONEDRIVE_CLIENT_ID,
    process.env.ONEDRIVE_CLIENT_SECRET
  );

  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: DEFAULT_SCOPES
  });

  return Client.initWithMiddleware({ authProvider });
}

/**
 * Ensures the target year.month folder exists in the Invoices directory.
 * @param {import('@microsoft/microsoft-graph-client').Client} client - Graph client instance
 * @param {string|Date} invoiceDate - Date to extract year/month from
 * @returns {Promise<string>} ID of the target folder
 * @throws {Error} If folder creation fails
 */
export async function ensureYearMonthFolder(client, invoiceDate) {
  if (!client || !invoiceDate) {
    throw new Error('Invalid parameters: client and invoiceDate are required');
  }

  const yearMonth = new Date(invoiceDate).toISOString().slice(0, 7).replace('-', '.');
  const rootPath = `${DRIVE_ROOT}/root:/${INVOICE_ROOT_PATH}`;

  try {
    const response = await client.api(`${rootPath}/${yearMonth}`).get();
    return response.id;
  } catch (error) {
    try {
      const response = await client
        .api(`${rootPath}:/children`)
        .post({
          name: yearMonth,
          folder: {},
          '@microsoft.graph.conflictBehavior': 'rename'
        });

      return response.id;
    } catch (folderCreationError) {
      throw new Error(`Failed to create directory '${yearMonth}': ${folderCreationError.message}`);
    }
  }
}

/**
 * Uploads a file to the specified OneDrive folder.
 * @param {import('@microsoft/microsoft-graph-client').Client} client - Graph client instance
 * @param {string} folderId - Target folder ID
 * @param {string} filename - Name of the file to upload
 * @param {Buffer} buffer - File content buffer
 * @param {string} [mime='application/octet-stream'] - MIME type of the file
 * @returns {Promise<void>}
 * @throws {Error} If upload operation fails
 */
export async function uploadFile(client, folderId, filename, buffer, mime = 'application/octet-stream') {
  if (!client || !folderId || !filename || !buffer) {
    throw new Error('Invalid parameters: client, folderId, filename and buffer are required');
  }

  try {
    await client
      .api(`${DRIVE_ROOT}/items/${folderId}:/${filename}:/content`)
      .header('Content-Type', mime)
      .put(buffer);
  } catch (error) {
    throw new Error(`File upload failed for '${filename}': ${error.message}`);
  }
}
