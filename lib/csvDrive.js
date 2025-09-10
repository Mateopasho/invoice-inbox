/**
 * @module csvDrive
 * @description Provides enterprise OneDrive integration functionality for invoice management
 *
 * This module facilitates:
 *   1. Verification and creation of the invoice data repository (CSV file)
 *   2. Secure append operations to maintain invoice records
 */

import { stringify } from 'csv-stringify/sync';
import 'isomorphic-fetch';

// Configuration for OneDrive API access
const userId = process.env.ONEDRIVE_USER_ID;  // Organization user identifier
const driveRoot = `/users/${userId}/drive`;

/**
 * Ensures the existence of the invoice data repository file
 * @param {Object} graph - Microsoft Graph client instance
 * @param {string} folderId - Target folder identifier
 * @returns {Promise<string>} File identifier of the invoice CSV
 */
export async function ensureCsvFile(graph, folderId) {
  // Validate existence of invoice repository
  const children = await graph
    .api(`${driveRoot}/items/${folderId}/children?$select=name,id`)
    .get();

  const csv = children.value.find(c => c.name === 'invoices.csv');
  if (csv) return csv.id;

  // Initialize repository with appropriate headers
  const header = stringify([
    ['Timestamp', 'Invoice Date', 'Seller', 'Total', 'Tax', 'Payment Method']
  ]);

  const res = await graph
    .api(`${driveRoot}/items/${folderId}:/${'invoices.csv'}:/content`)
    .header('Content-Type', 'application/octet-stream')
    .put(Buffer.from(header, 'utf8'));

  return res.id;
}

/**
 * Appends transaction data to the invoice repository
 * @param {Object} graph - Microsoft Graph client instance
 * @param {string} fileId - Invoice CSV file identifier
 * @param {Array} row - Transaction data to be recorded
 * @returns {Promise<void>}
 */
export async function appendCsvRow(graph, fileId, row) {
  // Retrieve current repository data
  const csvArrayBuffer = await graph
    .api(`${driveRoot}/items/${fileId}/content`)
    .responseType('arraybuffer')
    .get();

  // Process data for update operation
  const existing = Buffer.from(csvArrayBuffer).toString('utf8');
  const updated = existing + stringify([row]);

  // Commit updated repository
  await graph
    .api(`${driveRoot}/items/${fileId}/content`)
    .header('Content-Type', 'application/octet-stream')
    .put(Buffer.from(updated, 'utf8'));
}
