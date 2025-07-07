/**
 * lib/onedrive.js
 *
 * Lightweight Microsoft Graph helpers for:
 *   1. Authenticating (client‑credential flow)
 *   2. Ensuring a YYYY.MM folder exists under /Invoices
 *   3. Uploading a file into that folder
 *
 * Requirements:
 *   • Azure AD app with Files.ReadWrite.All (application) permission
 *   • Environment variables:
 *       ONEDRIVE_CLIENT_ID
 *       ONEDRIVE_CLIENT_SECRET
 *       ONEDRIVE_TENANT_ID        (tenant GUID or "organizations")
 *       ONEDRIVE_USER_ID          (UPN or GUID of the target OneDrive user)
 */

import { Client } from '@microsoft/microsoft-graph-client';
import {
  TokenCredentialAuthenticationProvider
} from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';
import { ClientSecretCredential } from '@azure/identity';
import 'isomorphic-fetch';

// ────────────────────────────────────────────────────────────
// Helpers: identify the drive we want to use
// ────────────────────────────────────────────────────────────
const userId   = process.env.ONEDRIVE_USER_ID;          // e.g. someone@tenant.onmicrosoft.com
const driveRoot = `/users/${userId}/drive`;              // base path for all calls

// ────────────────────────────────────────────────────────────
// 1. Create a Microsoft Graph client (app‑only token)
// ────────────────────────────────────────────────────────────
export async function getGraphClient() {
  const credential = new ClientSecretCredential(
    process.env.ONEDRIVE_TENANT_ID || 'organizations',   // tenant
    process.env.ONEDRIVE_CLIENT_ID,                      // client ID
    process.env.ONEDRIVE_CLIENT_SECRET                   // client secret
  );

  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: ['https://graph.microsoft.com/.default']
  });

  return Client.initWithMiddleware({ authProvider });
}

// ────────────────────────────────────────────────────────────
// 2. Ensure the /Invoices/YYYY.MM folder exists
// ────────────────────────────────────────────────────────────
export async function ensureYearMonthFolder(client) {
  const yearMonth = new Date().toISOString().slice(0, 7).replace('-', '.'); // e.g. 2025.07
  const rootPath  = `${driveRoot}/root:/Invoices`;                          // target root folder

  try {
    // Does the sub‑folder already exist?
    const res = await client.api(`${rootPath}/${yearMonth}`).get();
    return res.id;
  } catch {
    // Folder not found → create it
    const res = await client
      .api(`${rootPath}:/children`)
      .post({
        name: yearMonth,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'rename'
      });

    return res.id;
  }
}

// ────────────────────────────────────────────────────────────
// 3. Upload (or overwrite) a file inside that folder
// ────────────────────────────────────────────────────────────
export async function uploadFile(client, folderId, filename, buffer, mime = 'application/octet-stream') {
  await client
    .api(`${driveRoot}/items/${folderId}:/${filename}:/content`)
    .header('Content-Type', mime)
    .put(buffer);
}