const multer = require('multer');

/**
 * Upload guards.
 *
 * Multer's size limit is not enough on its own: every uploaded buffer is
 * written under UPLOAD_ROOT and later served back from /files, so the content
 * itself has to be what the route claims to accept. Both the declared MIME
 * type and the file's magic bytes are checked — a client-declared type alone
 * is trivially forged.
 */

const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const SPREADSHEET_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream', // browsers occasionally send this for .xlsx
  'text/csv',
]);

const IMAGE_MAGIC = [
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46], // GIF
  [0x52, 0x49, 0x46, 0x46], // RIFF/WEBP
];

function matchesMagic(buffer, signature) {
  return signature.every((byte, i) => buffer[i] === byte);
}

function looksLikeImage(buffer) {
  return Buffer.isBuffer(buffer) && IMAGE_MAGIC.some((sig) => matchesMagic(buffer, sig));
}

function mimeFilter(allowed) {
  return (req, file, cb) => {
    if (!allowed.has(file.mimetype)) {
      const err = new Error(`Unsupported file type "${file.mimetype}"`);
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  };
}

function makeUpload(field, maxMb, allowedMimeTypes) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxMb * 1024 * 1024, files: 1 },
    fileFilter: mimeFilter(allowedMimeTypes),
  }).single(field);
}

function verifyImageBytes(required) {
  return (req, res, next) => {
    if (!req.file) {
      if (required) return res.status(400).json({ error: 'No file uploaded' });
      return next();
    }
    if (!looksLikeImage(req.file.buffer)) {
      return res.status(400).json({ error: 'Uploaded file is not a valid PNG/JPEG/GIF/WebP image' });
    }
    next();
  };
}

/** Middleware pair: parse a single image field, then verify its magic bytes. */
function imageUpload(field, { maxMb = 10, required = false } = {}) {
  return [makeUpload(field, maxMb, IMAGE_MIME_TYPES), verifyImageBytes(required)];
}

/** Middleware for a single spreadsheet field (Excel catalog import). */
function spreadsheetUpload(field, { maxMb = 10 } = {}) {
  return makeUpload(field, maxMb, SPREADSHEET_MIME_TYPES);
}

module.exports = { imageUpload, spreadsheetUpload, looksLikeImage };
