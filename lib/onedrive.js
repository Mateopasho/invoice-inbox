/**
 * lib/onedrive.js
 * Lightweight Microsoft Graph helpers for:
 *   1. Authenticating
 *   2. Ensuring a YYYY.MM folder exists
 *   3. Uploading a file into that folder
 *
 * NOTE:
 * - The code below uses the **Client‑secret** flow (app registration +
 *   client secret).  If you prefer refresh‑token or device‑code, swap in your
 *   own credential type.
 * - Make sure the app has Files.ReadWrite.All permission on OneDrive.
 */

import { Client } from '@microsoft/microsoft-graph-client';
import {
  TokenCredentialAuthenticationProvider
} from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';
import { ClientSecretCredential } from '@azure/identity';
import 'isomorphic-fetch';

export async function getGraphClient() {
  const credential = new ClientSecretCredential(
    process.env.ONEDRIVE_TENANT_ID || 'common',
    process.env.ONEDRIVE_CLIENT_ID,
    process.env.ONEDRIVE_CLIENT_SECRET
  );

  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: ['https://graph.microsoft.com/.default']
  });

  return Client.initWithMiddleware({ authProvider });
}

export async function ensureYearMonthFolder(client) {
  const yearMonth = new Date().toISOString().slice(0, 7).replace('-', '.'); // 2025.07
  const root = '/drive/root:/Invoices'; // Change "Invoices" to any root folder you like

  try {
    const res = await client.api(`${root}/${yearMonth}`).get();
    return res.id;
  } catch {
    // Folder not found → create it
    const res = await client
      .api(`${root}:/children`)
      .post({
        name: yearMonth,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'rename'
      });
    return res.id;
  }
}

export async function uploadFile(client, folderId, filename, buffer) {
  await client
    .api(`/drive/items/${folderId}:/${filename}:/content`)
    .put(buffer);
}