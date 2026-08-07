/**
 * Storage service — local disk implementation.
 *
 * All file access in the app goes through this module. If you later move to
 * S3/MinIO (see requirements doc, Section 6.3), only this file needs to change;
 * routes/controllers should never touch `fs` directly.
 *
 * All operations are async (fs/promises) so file I/O never blocks the event loop.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const UPLOAD_ROOT = path.resolve(process.env.UPLOAD_ROOT || './uploads');

async function ensureDir(relativeDir) {
  const full = path.join(UPLOAD_ROOT, relativeDir);
  await fsp.mkdir(full, { recursive: true });
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

async function saveBuffer(relativeDir, filename, buffer) {
  const dir = await ensureDir(relativeDir);
  const relativePath = path.join(relativeDir, filename);
  await fsp.writeFile(path.join(dir, filename), buffer);
  return relativePath;
}

async function readFile(relativePath) {
  return fsp.readFile(absolutePath(relativePath));
}

async function exists(relativePath) {
  try {
    await fsp.access(absolutePath(relativePath));
    return true;
  } catch {
    return false;
  }
}

async function deleteFile(relativePath) {
  const full = absolutePath(relativePath);
  try {
    await fsp.unlink(full);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// Removes a folder if it's now empty — called after deleting the last file
// in an asset's directory so deleted assets don't leave empty UUID folders
// behind under UPLOAD_ROOT.
async function deleteDirIfEmpty(relativeDir) {
  const full = absolutePath(relativeDir);
  try {
    const entries = await fsp.readdir(full);
    if (entries.length === 0) await fsp.rmdir(full);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
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
