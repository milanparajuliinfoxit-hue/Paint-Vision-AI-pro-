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
  const full = absolutePath(relativeDir);
  fs.mkdirSync(full, { recursive: true });
  return full;
}

function absolutePath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.includes('\0')) {
    const err = new Error('Invalid path');
    err.status = 400;
    throw err;
  }
  const full = path.resolve(UPLOAD_ROOT, relativePath);
  // Guard against path traversal outside the upload root. A string prefix
  // check is not enough (`/data/uploads-old` shares the prefix of
  // `/data/uploads`), so compare the resolved relative path instead.
  const rel = path.relative(UPLOAD_ROOT, full);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    const err = new Error('Invalid path');
    err.status = 400;
    throw err;
  }
  return full;
}

function saveBuffer(relativeDir, filename, buffer) {
  const relativePath = path.join(relativeDir, filename);
  const target = absolutePath(relativePath); // rejects anything outside UPLOAD_ROOT
  ensureDir(relativeDir);
  fs.writeFileSync(target, buffer);
  return relativePath;
}

function readFile(relativePath) {
  return fs.readFileSync(absolutePath(relativePath));
}

function exists(relativePath) {
  try {
    return fs.existsSync(absolutePath(relativePath));
  } catch {
    return false; // paths outside the upload root simply don't exist as far as callers are concerned
  }
}

function deleteFile(relativePath) {
  if (!exists(relativePath)) return;
  const full = absolutePath(relativePath);
  if (fs.statSync(full).isFile()) fs.unlinkSync(full);
}

// Removes a folder if it's now empty — called after deleting the last file
// in an asset's directory so deleted assets don't leave empty UUID folders
// behind under UPLOAD_ROOT.
function deleteDirIfEmpty(relativeDir) {
  const full = absolutePath(relativeDir);
  if (fs.existsSync(full) && fs.readdirSync(full).length === 0) fs.rmdirSync(full);
}

module.exports = {
  UPLOAD_ROOT,
  ensureDir,
  absolutePath,
  saveBuffer,
  readFile,
  exists,
  deleteFile,
  deleteDirIfEmpty,
};
