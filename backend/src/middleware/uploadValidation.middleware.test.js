const test = require('node:test');
const assert = require('node:assert/strict');
const {
  imageFileFilter, xlsxFileFilter, isRealImage, isRealXlsx,
  peekImageDimensions, exceedsMaxDimensions, MAX_IMAGE_DIMENSION,
} = require('./uploadValidation.middleware');

// Builds a minimal-but-real PNG header (signature + IHDR chunk) declaring
// the given dimensions — enough for peekImageDimensions to read, without
// needing an actual encoder. This is exactly the "small file, huge claimed
// dimensions" shape a real decompression-bomb PNG has.
function fakePngHeader(width, height) {
  const buf = Buffer.alloc(33);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // PNG signature
  buf.writeUInt32BE(13, 8); // IHDR chunk length
  buf.write('IHDR', 12);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function fakeGifHeader(width, height) {
  const buf = Buffer.alloc(10);
  buf.write('GIF89a', 0);
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

// Minimal JPEG: SOI, then an SOF0 (0xFFC0) segment carrying the dimensions.
function fakeJpegHeader(width, height) {
  const buf = Buffer.alloc(19);
  buf.set([0xff, 0xd8], 0); // SOI
  buf.set([0xff, 0xc0], 2); // SOF0 marker
  buf.writeUInt16BE(11, 4); // segment length (2 length + 1 precision + 2 height + 2 width + 3 component + ...) close enough for the parser, which only reads up to offset+9
  buf.writeUInt8(8, 6); // precision
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  return buf;
}

function runFilter(filter, mimetype) {
  let result;
  filter({}, { mimetype }, (err, ok) => { result = { err, ok }; });
  return result;
}

test('imageFileFilter accepts real image mimetypes', () => {
  for (const mt of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
    const { err, ok } = runFilter(imageFileFilter, mt);
    assert.equal(err, null, mt); // multer's cb(error, accept) convention — null, not undefined, means "no error"
    assert.equal(ok, true, mt);
  }
});

test('imageFileFilter rejects non-image mimetypes with a 400', () => {
  for (const mt of ['application/x-msdownload', 'text/html', 'application/pdf', 'application/octet-stream']) {
    const { err } = runFilter(imageFileFilter, mt);
    assert.ok(err instanceof Error, mt);
    assert.equal(err.status, 400, mt);
  }
});

test('xlsxFileFilter accepts spreadsheet mimetypes, rejects everything else', () => {
  assert.equal(runFilter(xlsxFileFilter, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').ok, true);
  assert.ok(runFilter(xlsxFileFilter, 'image/png').err);
});

// Regression test: curl (and evidently some real clients) send
// "application/octet-stream" for a genuine .xlsx upload — found by actually
// testing an import, not by reading the code. The mimetype filter must not
// reject that; isRealXlsx (byte-level) is the real gate.
test('xlsxFileFilter accepts the generic octet-stream fallback (real clients send this for genuine .xlsx)', () => {
  assert.equal(runFilter(xlsxFileFilter, 'application/octet-stream').ok, true);
});

test('isRealXlsx recognizes a real ZIP/OOXML signature and rejects everything else', () => {
  assert.equal(isRealXlsx(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0])), true);
  assert.equal(isRealXlsx(Buffer.from('not a spreadsheet at all')), false);
  assert.equal(isRealXlsx(Buffer.alloc(0)), false);
  assert.equal(isRealXlsx(null), false);
});

test('peekImageDimensions reads real dimensions from PNG/GIF/JPEG headers without decoding pixels', () => {
  assert.deepEqual(peekImageDimensions(fakePngHeader(1920, 1080)), { width: 1920, height: 1080 });
  assert.deepEqual(peekImageDimensions(fakeGifHeader(640, 480)), { width: 640, height: 480 });
  assert.deepEqual(peekImageDimensions(fakeJpegHeader(3000, 2000)), { width: 3000, height: 2000 });
});

test('exceedsMaxDimensions rejects a decompression-bomb-shaped file — huge claimed dimensions in a tiny header', () => {
  // The whole point: this "file" is 33 bytes on the wire but claims a
  // 60000x60000 canvas (a real decode would try to allocate ~14 GB).
  const bomb = fakePngHeader(60000, 60000);
  assert.equal(bomb.length, 33);
  assert.equal(exceedsMaxDimensions(bomb), true);
});

test('exceedsMaxDimensions accepts real-world photo dimensions', () => {
  assert.equal(exceedsMaxDimensions(fakePngHeader(4032, 3024)), false); // typical phone photo
  assert.equal(exceedsMaxDimensions(fakeJpegHeader(6000, 4000)), false); // typical DSLR photo
});

test('exceedsMaxDimensions never false-positives on a format it cannot parse (WEBP) — falls back to size/magic-byte checks instead', () => {
  const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  assert.equal(peekImageDimensions(webp), null);
  assert.equal(exceedsMaxDimensions(webp), false);
});

test('exceedsMaxDimensions rejects a zero/negative-shaped header (malformed, not a real photo)', () => {
  assert.equal(exceedsMaxDimensions(fakePngHeader(0, 100)), true);
});

test(`MAX_IMAGE_DIMENSION is a real, sane bound (${MAX_IMAGE_DIMENSION}px)`, () => {
  assert.ok(MAX_IMAGE_DIMENSION >= 4000 && MAX_IMAGE_DIMENSION <= 20000);
});

test('isRealImage recognizes real magic bytes and rejects everything else', () => {
  assert.equal(isRealImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), true); // JPEG
  assert.equal(isRealImage(Buffer.from([0x89, 0x50, 0x4e, 0x47])), true); // PNG
  assert.equal(isRealImage(Buffer.from([0x47, 0x49, 0x46, 0x38])), true); // GIF
  assert.equal(isRealImage(Buffer.from([0x52, 0x49, 0x46, 0x46])), true); // RIFF/WEBP

  assert.equal(isRealImage(Buffer.from('MZ\x90\x00')), false); // a Windows .exe header, renamed to .jpg
  assert.equal(isRealImage(Buffer.from('<html>')), false);
  assert.equal(isRealImage(Buffer.alloc(0)), false);
  assert.equal(isRealImage(null), false);
});
