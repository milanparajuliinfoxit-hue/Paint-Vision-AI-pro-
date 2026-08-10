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
  const full = path.resolve(UPLOAD_ROOT, String(relativePath || ''));
  // Guard against path traversal outside the upload root. Comparing against
  // the root plus a separator keeps a sibling directory whose name merely
  // starts with the root (e.g. `<root>-backup`) from passing the check.
  if (full !== UPLOAD_ROOT && !full.startsWith(UPLOAD_ROOT + path.sep)) {
    const err = new Error('Invalid path');
    err.status = 400;
    throw err;
  }
  return full;
}

function saveBuffer(relativeDir, filename, buffer) {
  const relativePath = path.join(relativeDir, filename);
  absolutePath(relativePath); // reject writes outside the upload root
  const dir = ensureDir(relativeDir);
  fs.writeFileSync(path.join(dir, filename), buffer);
  return relativePath;
}

function readFile(relativePath) {
  try {
    return fs.readFileSync(absolutePath(relativePath));
  } catch (err) {
    // Surface a missing file as a 404 with a message that names the stored
    // path, not the server's absolute filesystem layout.
    if (err.code === 'ENOENT') {
      const missing = new Error(`Stored file not found: ${relativePath}`);
      missing.status = 404;
      missing.code = 'ENOENT';
      throw missing;
    }
    throw err;
  }
}

function exists(relativePath) {
  try {
    return fs.existsSync(absolutePath(relativePath));
  } catch {
    return false; // a traversal attempt is "not found", not a server error
  }
}

function deleteFile(relativePath) {
  const full = absolutePath(relativePath);
  if (fs.existsSync(full)) fs.unlinkSync(full);
}

// Deleting a file we no longer reference must never fail the request that
// already removed the owning DB row — the caller has nothing to roll back
// to. Report the failure to the caller (which logs it) instead of throwing.
function tryDeleteFile(relativePath) {
  if (!relativePath) return null;
  try {
    deleteFile(relativePath);
    return null;
  } catch (err) {
    return err;
  }
}

// Removes a folder if it's now empty — called after deleting the last file
// in an asset's directory so deleted assets don't leave empty UUID folders
// behind under UPLOAD_ROOT.
function deleteDirIfEmpty(relativeDir) {
  const full = absolutePath(relativeDir);
  if (fs.existsSync(full) && fs.readdirSync(full).length === 0) fs.rmdirSync(full);
}

function tryDeleteDirIfEmpty(relativeDir) {
  try {
    deleteDirIfEmpty(relativeDir);
    return null;
  } catch (err) {
    return err;
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
  tryDeleteFile,
  deleteDirIfEmpty,
  tryDeleteDirIfEmpty,
};
