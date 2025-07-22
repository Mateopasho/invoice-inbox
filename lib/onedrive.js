import { Client } from '@microsoft/microsoft-graph-client';
import {
  TokenCredentialAuthenticationProvider
} from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';
import { ClientSecretCredential } from '@azure/identity';
import 'isomorphic-fetch';

const userId = process.env.ONEDRIVE_USER_ID;
const driveRoot = `/users/${userId}/drive`;

export async function getGraphClient() {
  const credential = new ClientSecretCredential(
    process.env.ONEDRIVE_TENANT_ID || 'organizations',
    process.env.ONEDRIVE_CLIENT_ID,
    process.env.ONEDRIVE_CLIENT_SECRET
  );

  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: ['https://graph.microsoft.com/.default']
  });

  return Client.initWithMiddleware({ authProvider });
}

export async function ensureYearMonthFolder(client, invoiceDate) {
  const yearMonth = new Date(invoiceDate).toISOString().slice(0, 7).replace('-', '.');
  const rootPath = `${driveRoot}/root:/Invoices`;

  try {
    const res = await client.api(`${rootPath}/${yearMonth}`).get();
    return res.id;
  } catch {
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

export async function uploadFile(client, folderId, filename, buffer, mime = 'application/octet-stream') {
  await client
    .api(`${driveRoot}/items/${folderId}:/${filename}:/content`)
    .header('Content-Type', mime)
    .put(buffer);
}
