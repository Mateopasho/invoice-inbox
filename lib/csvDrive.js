/**
 * lib/csvDrive.js
 *
 * Utilities to:
 *   1. Ensure invoices.csv exists inside a OneDrive folder
 *   2. Append a row to that CSV (download → append → re‑upload)
 */

import { stringify } from 'csv-stringify/sync';
import 'isomorphic-fetch';

export async function ensureCsvFile(graph, folderId) {
  // 1. List children to see if invoices.csv exists
  const children = await graph
    .api(`/drive/items/${folderId}/children?$select=name,id`)
    .get();
  const csv = children.value.find(c => c.name === 'invoices.csv');
  if (csv) return csv.id;

  // 2. Create new CSV with header row
  const header = stringify([
    ['Timestamp', 'Invoice Date', 'Seller', 'Total', 'Tax', 'Payment Method']
  ]);
  const res = await graph
    .api(`/drive/items/${folderId}:/${'invoices.csv'}:/content`)
    .put(header, { headers: { 'Content-Type': 'text/csv' } });
  return res.id;
}

export async function appendCsvRow(graph, fileId, row) {
  // 1. Download current CSV
  const csvRes = await graph.api(`/drive/items/${fileId}/content`).get();
  const existing = await csvRes.text();

  // 2. Append new line
  const updated = existing + stringify([row]);

  // 3. Upload (overwrite)
  await graph
    .api(`/drive/items/${fileId}/content`)
    .put(updated, { headers: { 'Content-Type': 'text/csv' } });
}