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

// Removes a folder if it's now empty — called after deleting the last file
// in an asset's directory so deleted assets don't leave empty UUID folders
// behind under UPLOAD_ROOT.
function deleteDirIfEmpty(relativeDir) {
  const full = absolutePath(relativeDir);
  if (fs.existsSync(full) && fs.readdirSync(full).length === 0) fs.rmdirSync(full);
}

// Directory layout, in one place — controllers name what they're storing
// instead of re-joining path segments at each call site.
// UPLOAD_ROOT already ends in the app's uploads folder, so an asset's own
// files need no extra nesting.
const assetDir = (assetId) => String(assetId);
const maskDir = (assetId) => path.join('uploads', String(assetId), 'masks');
const projectDir = (projectId, subfolder) => path.join('uploads', 'projects', String(projectId), subfolder);

module.exports = {
  UPLOAD_ROOT,
  ensureDir,
  assetDir,
  maskDir,
  projectDir,
  absolutePath,
  saveBuffer,
  readFile,
  exists,
  deleteFile,
  deleteDirIfEmpty,
};
