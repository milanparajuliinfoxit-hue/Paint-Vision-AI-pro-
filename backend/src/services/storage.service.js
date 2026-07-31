/**
 * Storage service — local disk implementation.
 *
 * All file access in the app goes through this module. If you later move to
 * S3/MinIO (see requirements doc, Section 6.3), only this file needs to change;
 * routes/controllers should never touch `fs` directly.
 */
const fs = require('fs');
const path = require('path');

const UPLOAD_ROOT = path.resolve(process.env.UPLOAD_ROOT || './uploads');

function ensureDir(relativeDir) {
  const full = path.join(UPLOAD_ROOT, relativeDir);
  fs.mkdirSync(full, { recursive: true });
  return full;
}

function absolutePath(relativePath) {
  const full = path.join(UPLOAD_ROOT, relativePath);
  // Guard against path traversal outside the upload root.
  if (!full.startsWith(UPLOAD_ROOT)) {
    throw new Error('Invalid path');
  }
  return full;
}

function saveBuffer(relativeDir, filename, buffer) {
  const dir = ensureDir(relativeDir);
  const relativePath = path.join(relativeDir, filename);
  fs.writeFileSync(path.join(dir, filename), buffer);
  return relativePath;
}

function readFile(relativePath) {
  return fs.readFileSync(absolutePath(relativePath));
}

function exists(relativePath) {
  return fs.existsSync(absolutePath(relativePath));
}

function deleteFile(relativePath) {
  const full = absolutePath(relativePath);
  if (fs.existsSync(full)) fs.unlinkSync(full);
}

module.exports = {
  UPLOAD_ROOT,
  ensureDir,
  absolutePath,
  saveBuffer,
  readFile,
  exists,
  deleteFile,
};
