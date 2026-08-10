const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// UPLOAD_ROOT is read at module-load time from process.env.UPLOAD_ROOT — set
// before requiring so this suite never touches the real backend/uploads/.
const scratchRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'storage-test-'));
process.env.UPLOAD_ROOT = scratchRoot;
const storage = require('./storage.service');

test.after(() => {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

test('removeTree deletes an entire populated directory tree', async () => {
  await storage.saveBuffer('assetA', 'original.jpg', Buffer.from('photo'));
  await storage.saveBuffer(path.join('assetA', 'masks'), 'm1.png', Buffer.from('mask1'));
  await storage.saveBuffer(path.join('assetA', 'masks'), 'm2.png', Buffer.from('mask2'));
  assert.ok(fs.existsSync(path.join(scratchRoot, 'assetA', 'masks', 'm1.png')));

  await storage.removeTree('assetA');

  assert.ok(!fs.existsSync(path.join(scratchRoot, 'assetA')), 'the whole assetA directory tree should be gone, including nested subdirectories');
});

test('removeTree on a directory that never existed is a silent no-op (idempotent), not an error', async () => {
  await assert.doesNotReject(() => storage.removeTree('never-existed-dir'));
});

test('removeTree respects the traversal guard — cannot escape UPLOAD_ROOT', async () => {
  await assert.rejects(() => storage.removeTree('../../etc'), /Invalid path/);
  await assert.rejects(() => storage.removeTree('../sibling-of-upload-root'), /Invalid path/);
});

test('removeTree only removes the targeted subtree, leaving sibling asset directories untouched', async () => {
  await storage.saveBuffer('assetB', 'original.jpg', Buffer.from('keep-me'));
  await storage.saveBuffer('assetC', 'original.jpg', Buffer.from('delete-me'));

  await storage.removeTree('assetC');

  assert.ok(fs.existsSync(path.join(scratchRoot, 'assetB', 'original.jpg')), 'sibling asset must survive');
  assert.ok(!fs.existsSync(path.join(scratchRoot, 'assetC')));
});

// Regression test for the exact bug this was built to fix: layer masks are
// saved under a *different* real location (uploads/<assetId>/masks, see
// layers.controller.js) than the asset's own directory (<assetId>/) — a
// cleanup that only removes <assetId>/ leaves the uploads/<assetId>/
// wrapper (and its mask files) orphaned on disk forever.
test('an asset\'s two disjoint real locations (own dir + nested uploads/<id> masks wrapper) are both removable independently', async () => {
  await storage.saveBuffer('assetD', 'original.jpg', Buffer.from('photo'));
  await storage.saveBuffer(path.join('uploads', 'assetD', 'masks'), 'layer1.png', Buffer.from('mask'));
  assert.ok(fs.existsSync(path.join(scratchRoot, 'uploads', 'assetD', 'masks', 'layer1.png')));

  await storage.removeTree('assetD');
  await storage.removeTree(path.join('uploads', 'assetD'));

  assert.ok(!fs.existsSync(path.join(scratchRoot, 'assetD')));
  assert.ok(!fs.existsSync(path.join(scratchRoot, 'uploads', 'assetD')), 'the nested masks wrapper directory must not survive');
});
