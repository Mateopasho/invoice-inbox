/**
 * lib/csvDrive.js
 *
 * Utilities to:
 *   1. Ensure invoices.csv exists inside a OneDrive folder
 *   2. Append a row to that CSV (download → append → re‑upload)
 */

import { stringify } from 'csv-stringify/sync';
import 'isomorphic-fetch';

// ────────────────────────────────────────────────────────────
// Helper: target the correct drive for an app‑only token
// ────────────────────────────────────────────────────────────
const userId   = process.env.ONEDRIVE_USER_ID;          // e.g. someone@tenant.onmicrosoft.com
const driveRoot = `/users/${userId}/drive`;

// ────────────────────────────────────────────────────────────
// 1. Ensure invoices.csv exists
// ────────────────────────────────────────────────────────────
export async function ensureCsvFile(graph, folderId) {
  // 1‑A. List children to see if invoices.csv exists
  const children = await graph
    .api(`${driveRoot}/items/${folderId}/children?$select=name,id`)
    .get();

  const csv = children.value.find(c => c.name === 'invoices.csv');
  if (csv) return csv.id;

  // 1‑B. Create new CSV with a header row
  const header = stringify([
    ['Timestamp', 'Invoice Date', 'Seller', 'Total', 'Tax', 'Payment Method']
  ]);

  const res = await graph
    .api(`${driveRoot}/items/${folderId}:/${'invoices.csv'}:/content`)
    .header('Content-Type', 'application/octet-stream')   // ← NEW
    .put(Buffer.from(header, 'utf8'));

  return res.id;
}

// ────────────────────────────────────────────────────────────
// 2. Append a row to invoices.csv
// ────────────────────────────────────────────────────────────
export async function appendCsvRow(graph, fileId, row) {
  // 1. Download current CSV (as ArrayBuffer)
  const csvArrayBuffer = await graph
    .api(`${driveRoot}/items/${fileId}/content`)
    .responseType('arraybuffer')
    .get();

  // 2. Convert to UTF‑8 text
  const existing = Buffer.from(csvArrayBuffer).toString('utf8');

  // 3. Append the new line
  const updated = existing + stringify([row]);

  // 4. Upload (overwrite) this is a comment for testing
  //    the updated CSV
  await graph
    .api(`${driveRoot}/items/${fileId}/content`)
    .header('Content-Type', 'application/octet-stream')   // ← NEW
    .put(Buffer.from(updated, 'utf8'));
}
