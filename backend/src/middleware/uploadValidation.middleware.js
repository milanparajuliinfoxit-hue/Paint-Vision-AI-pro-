/**
 * Upload validation for every multer route in the app. Previously there was
 * no fileFilter or content check anywhere — any file type could be
 * uploaded as a "photo," stored under a .jpg name regardless of its real
 * content, and served back through /files/* with whatever content-type the
 * .jpg extension implies. Same gap existed for the Excel catalog import.
 *
 * Two layers, for both formats, because Content-Type alone is not a
 * trustworthy signal (a real client can legitimately send
 * "application/octet-stream" for a genuine .xlsx — found by testing with
 * curl, which does exactly that; rejecting on mimetype alone would have
 * bounced real uploads, not just attacks):
 *   - {image,xlsx}FileFilter: multer's fileFilter, runs before the body is
 *     fully read — rejects obviously-wrong uploads early/cheaply, but
 *     treats an ambiguous/generic Content-Type as "unknown," not "invalid,"
 *     deferring the real decision to the byte check below.
 *   - isRealImage / isRealXlsx: checked after the buffer is in memory (in
 *     the controller) against actual magic bytes — can't be spoofed by a
 *     renamed file or a fake Content-Type header, and unlike the mimetype,
 *     is authoritative. (isRealXlsx also closes a separate gap: the `xlsx`
 *     library does NOT throw on non-spreadsheet input — it silently
 *     returns a fabricated empty workbook — so without this check, garbage
 *     input previously produced a confusing "0 rows found" instead of a
 *     clear rejection.)
 */
const ALLOWED_IMAGE_MIMETYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const ALLOWED_XLSX_MIMETYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel', // .xls (legacy, some browsers/OSes still report this for .xlsx)
  'application/octet-stream', // common generic fallback many clients send for .xlsx — isRealXlsx is the real gate
]);

function makeFileFilter(allowedMimetypes, description) {
  return function fileFilter(req, file, cb) {
    if (!allowedMimetypes.has(file.mimetype)) {
      const err = new Error(`Unsupported file type "${file.mimetype}" — upload ${description}.`);
      err.status = 400; // errorHandler.middleware.js defaults to 500 without this
      return cb(err);
    }
    cb(null, true);
  };
}

const imageFileFilter = makeFileFilter(ALLOWED_IMAGE_MIMETYPES, 'a JPEG, PNG, WEBP, or GIF image');
const xlsxFileFilter = makeFileFilter(ALLOWED_XLSX_MIMETYPES, 'an Excel (.xlsx) file');

const IMAGE_MAGIC = [
  [0xff, 0xd8, 0xff], // JPEG
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0x47, 0x49, 0x46, 0x38], // GIF
  [0x52, 0x49, 0x46, 0x46], // RIFF (WEBP container)
];

function isRealImage(buffer) {
  if (!buffer || buffer.length < 4) return false;
  return IMAGE_MAGIC.some((magic) => magic.every((b, i) => buffer[i] === b));
}

// .xlsx is a ZIP container (OOXML) — real ones start with a standard ZIP
// local-file-header signature. This is what actually gates "is this a real
// spreadsheet," since the `xlsx` library itself doesn't (see module docblock).
const ZIP_MAGIC = [
  [0x50, 0x4b, 0x03, 0x04], // normal
  [0x50, 0x4b, 0x05, 0x06], // empty archive
  [0x50, 0x4b, 0x07, 0x08], // spanned archive
];

function isRealXlsx(buffer) {
  if (!buffer || buffer.length < 4) return false;
  return ZIP_MAGIC.some((magic) => magic.every((b, i) => buffer[i] === b));
}

// A generous ceiling for a real exterior house photo — well above anything
// a phone or DSLR produces, but far below what a crafted "decompression
// bomb" file claims (a PNG can declare e.g. 60000x60000 pixels in 24 bytes
// of header while being a few KB on disk; decoding that allocates ~14 GB).
const MAX_IMAGE_DIMENSION = 8000;

// Reads width/height straight out of the format header, WITHOUT decoding
// any pixel data — the entire point of a decompression-bomb guard is to
// reject an oversized image *before* paying the CPU/memory cost of a full
// decode (which, before this, happened unguarded: Jimp.read() in
// mockProvider.js, houseUnderstanding.service.js, and assets.controller.js's
// cleanup path all fully decode first and only find out the image was huge
// after already allocating for it).
//
// Returns null when the format doesn't have a cheap-to-read fixed/simple
// header this parses (currently: WEBP) — callers should treat null as
// "couldn't verify," not as "rejected," so a legitimate WEBP upload isn't
// blocked by a gap in this parser; the byte-size limit (multer `limits`)
// and isRealImage() still apply to it regardless.
function peekImageDimensions(buffer) {
  // Each format needs a different minimum length to safely read its header
  // fields — a single blanket guard sized for the largest one (PNG, 24
  // bytes) would reject perfectly valid, shorter GIF headers before ever
  // reaching the GIF branch. Guard per-branch instead.
  if (!buffer || buffer.length < 10) return null;

  // PNG: 8-byte signature, 4-byte chunk length, "IHDR", then width/height
  // as big-endian uint32 at fixed offsets 16 and 20.
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  // GIF: fixed 6-byte "GIF8[7|9]a" header, then width/height as
  // little-endian uint16.
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }

  // JPEG: walk the marker segments until a Start-Of-Frame marker
  // (0xFFC0-0xFFCF, excluding the DHT/JPG-extension markers C4/C8/CC) —
  // its payload is 1 byte precision, then height, then width, each a
  // big-endian uint16.
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { offset += 2; continue; }
      const segmentLength = buffer.readUInt16BE(offset + 2);
      const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isStartOfFrame) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + segmentLength;
    }
  }

  return null;
}

function exceedsMaxDimensions(buffer, maxDim = MAX_IMAGE_DIMENSION) {
  const dims = peekImageDimensions(buffer);
  if (!dims) return false; // unknown/unparsed format — don't false-positive-block a legitimate upload
  return dims.width <= 0 || dims.height <= 0 || dims.width > maxDim || dims.height > maxDim;
}

module.exports = {
  imageFileFilter, xlsxFileFilter, isRealImage, isRealXlsx,
  peekImageDimensions, exceedsMaxDimensions, MAX_IMAGE_DIMENSION,
};
