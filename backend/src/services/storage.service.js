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
  const full = path.resolve(UPLOAD_ROOT, relativePath);
  // Guard against path traversal outside the upload root. A plain
  // full.startsWith(UPLOAD_ROOT) string check is bypassable by a
  // sibling-prefix path (e.g. UPLOAD_ROOT '/data/uploads' would also match
  // '/data/uploads-evil/x.png') — path.relative + containment doesn't have
  // that gap, since a genuine escape always starts with '..' or resolves to
  // a different root entirely (absolute on the other side).
  const rel = path.relative(UPLOAD_ROOT, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
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

// Recursively removes an entire directory tree that is *exclusively owned*
// by one resource (an asset id, a project's uploads/projects/<id> folder) —
// never call this with anything derived from user-supplied input; the
// caller is responsible for passing a server-known, DB-verified id.
// absolutePath()'s traversal guard still applies as a second layer of
// defense (throws before anything is touched if relativeDir somehow
// resolved outside UPLOAD_ROOT). force:true makes this idempotent — a
// directory that's already gone (or never existed) is not an error, the
// same tolerance deleteFile/deleteDirIfEmpty already have via ENOENT.
//
// This replaced a previous approach of deleting known files one at a time
// and then pruning specific subdirectories "if empty": that requires the
// caller to know about *every* file/subdirectory a resource could ever
// have, and missed one (a nested uploads/<assetId>/masks wrapper folder —
// see layers.controller.js's mask relativeDir, which nests under an extra
// literal "uploads" segment that asset photos don't), leaving orphaned
// UUID directories on disk after a project/asset was already deleted from
// the database. A single recursive removal of the resource's whole owned
// subtree can't have that class of gap.
async function removeTree(relativeDir) {
  const full = absolutePath(relativeDir);
  await fsp.rm(full, { recursive: true, force: true });
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
  removeTree,
};
