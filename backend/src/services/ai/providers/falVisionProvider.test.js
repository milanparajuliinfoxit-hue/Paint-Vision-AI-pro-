const test = require('node:test');
const assert = require('node:assert/strict');
const provider = require('./falVisionProvider');

// Pure-logic tests only — no network, no FAL_API_KEY needed. Real live
// model calls are verified separately once a key exists (see
// AI_HOSTED_ARCHITECTURE.md §9 / AI_FAL_IMPLEMENTATION_REPORT.md).

test('run() tags a missing-key failure with stage "config"', async () => {
  const saved = process.env.FAL_API_KEY;
  delete process.env.FAL_API_KEY;
  try {
    await assert.rejects(
      () => provider.run('house-understanding', { buffer: Buffer.from([]) }),
      (err) => {
        assert.match(err.message, /FAL_API_KEY is missing/);
        assert.equal(err.stage, 'config');
        return true;
      }
    );
  } finally {
    if (saved !== undefined) process.env.FAL_API_KEY = saved;
  }
});

test('denormalizeBox converts [cx,cy,w,h] normalized to [x0,y0,x1,y1] pixels', () => {
  // A box centered at (0.5, 0.5) covering half the width/height of a 100x80 image.
  const box = provider.denormalizeBox([0.5, 0.5, 0.5, 0.5], 100, 80);
  assert.deepEqual(box, [25, 20, 75, 60]);
});

test('denormalizeBox returns null for a malformed box', () => {
  assert.equal(provider.denormalizeBox([0.5, 0.5], 100, 80), null);
  assert.equal(provider.denormalizeBox(null, 100, 80), null);
  assert.equal(provider.denormalizeBox([0.5, 0.5, 'x', 0.5], 100, 80), null);
});

test('rasterizeBoxes fills a rectangular region per box, handling reversed coordinates', () => {
  const mask = provider.rasterizeBoxes([[10, 10, 5, 5]], 20, 20); // x1<x0, y1<y0
  assert.equal(mask[7 * 20 + 7], 1);
  assert.equal(mask[10 * 20 + 10], 1);
  assert.equal(mask[0 * 20 + 0], 0);
});
