#!/usr/bin/env node
// scripts/watch-attachments.js
import chokidar from "chokidar";
import path from "path";
import fs from "fs/promises";
import fssync from "fs";
import dotenv from "dotenv";
import { OpenAI } from "openai";

dotenv.config();

// 👉 Your processor:
import { processAttachment } from "../lib/invoiceProcessor.js";

// Watch <repo>/api/attachments by default; allow override via ATTACHMENTS_DIR
const DEFAULT_ATTACHMENTS_DIR = path.join("api", "attachments");
const ATTACHMENTS_DIR = path.resolve(
  process.env.ATTACHMENTS_DIR ?? DEFAULT_ATTACHMENTS_DIR
);
const PROCESSED_DIR = path.join(ATTACHMENTS_DIR, "processed");
const FAILED_DIR = path.join(ATTACHMENTS_DIR, "failed");

// One OpenAI client instance passed to your processor
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function ensureDirs() {
  for (const d of [ATTACHMENTS_DIR, PROCESSED_DIR, FAILED_DIR]) {
    if (!fssync.existsSync(d)) await fs.mkdir(d, { recursive: true });
  }
}

function isFinalInvoice(name) {
  const base = name.toLowerCase();
  if (base.startsWith(".")) return false;
  if (
    base.endsWith(".crdownload") ||
    base.endsWith(".download") ||
    base.endsWith(".partial")
  )
    return false;
  // Your processor supports pdf + image/*
  return /\.(pdf|png|jpg|jpeg|webp|tif|tiff|heic)$/i.test(base);
}

function guessContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    case ".heic":
      return "image/heic";
    default:
      return "application/octet-stream";
  }
}

async function safeRename(oldPath, newPath) {
  try {
    await fs.rename(oldPath, newPath);
  } catch (err) {
    if (err.code === "EXDEV") {
      // Cross-device move fallback: copy then unlink
      await fs.copyFile(oldPath, newPath);
      await fs.unlink(oldPath);
    } else {
      throw err;
    }
  }
}

// Avoid clobbering if a file with the same name already exists in processed/failed
async function getUniqueDest(dir, filename) {
  let dest = path.join(dir, filename);
  if (!fssync.existsSync(dest)) return dest;
  const { name, ext } = path.parse(filename);
  let i = 1;
  // Keep trying name-1.ext, name-2.ext, ...
  while (true) {
    // eslint-disable-line no-constant-condition
    const candidate = path.join(dir, `${name}-${i}${ext}`);
    if (!fssync.existsSync(candidate)) return candidate;
    i++;
  }
}

async function handle(filePath) {
  // Give the OS some time to finish writing the file
  await new Promise((r) => setTimeout(r, 600));

  // Skip if missing, empty, or not a regular file
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size === 0) return;
  } catch {
    return;
  }

  const filename = path.basename(filePath);
  const contentType = guessContentType(filename);

  try {
    console.log("start to read the file:", filePath);

    const buffer = await fs.readFile(filePath);

    // Call YOUR pipeline
    const result = await processAttachment(
      { buffer, filename, contentType },
      openai
    );
    if (!result?.ok)
      throw new Error(result?.error || "Processor reported failure");

    const dest = await getUniqueDest(PROCESSED_DIR, filename);
    await safeRename(filePath, dest);
    console.log("✔ processed", filename);
  } catch (err) {
    console.error("✖ failed", filename, err?.message || err);
    try {
      const dest = await getUniqueDest(FAILED_DIR, filename);
      await safeRename(filePath, dest);
    } catch {}
  }
}

async function main() {
  await ensureDirs();

  // Process any existing files on startup (top-level only)
  for (const f of fssync.readdirSync(ATTACHMENTS_DIR)) {
    const full = path.join(ATTACHMENTS_DIR, f);
    if (fssync.statSync(full).isFile() && isFinalInvoice(f)) handle(full);
  }

  const watcher = chokidar.watch(ATTACHMENTS_DIR, {
    persistent: true,
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 120 },
  });

  watcher.on("add", (fp) => {
    if (isFinalInvoice(path.basename(fp))) handle(fp);
  });
  watcher.on("error", (e) => console.error("Watcher error:", e));

  console.log("Watching:", ATTACHMENTS_DIR);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
