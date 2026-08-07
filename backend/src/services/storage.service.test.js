const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// storage.service.js resolves UPLOAD_ROOT from process.env.UPLOAD_ROOT at
// require time, so set it before requiring the module.
process.env.UPLOAD_ROOT = path.join(__dirname, '__test_uploads__');
const storage = require('./storage.service');

test('a normal relative path resolves inside UPLOAD_ROOT', () => {
  const full = storage.absolutePath('abc-123/original.jpg');
  assert.ok(full.startsWith(storage.UPLOAD_ROOT));
});

test('classic ../ traversal is rejected', () => {
  assert.throws(() => storage.absolutePath('../../../etc/passwd'), /Invalid path/);
});

test('a sibling-directory prefix trick is rejected (not fooled by string prefix matching)', () => {
  // UPLOAD_ROOT + '-evil' string-starts-with UPLOAD_ROOT but is a different
  // directory entirely — this is exactly the bypass a plain
  // full.startsWith(UPLOAD_ROOT) check would miss.
  const evilSibling = path.relative(storage.UPLOAD_ROOT, `${storage.UPLOAD_ROOT}-evil/x.png`);
  assert.throws(() => storage.absolutePath(evilSibling), /Invalid path/);
});

test('an absolute path outside the root is rejected', () => {
  assert.throws(() => storage.absolutePath(path.resolve(__dirname, '..')), /Invalid path/);
});
