const test = require('node:test');
const assert = require('node:assert/strict');
const geom = require('./maskGeometry');

// Pure geometry — no network, no IO. Same helpers the deleted local pipeline
// used (see AI_HOSTED_ARCHITECTURE.md §2); these tests exist so a future
// change to the shared geometry can't silently break every provider that
// depends on it (currently only replicateVisionProvider.js).

function mask(W, H, onCells) {
  const m = new Uint8Array(W * H);
  for (const [x, y] of onCells) m[y * W + x] = 1;
  return m;
}

test('toAlpha255 maps 0/1 booleans to 0/255', () => {
  const m = new Uint8Array([0, 1, 1, 0]);
  assert.deepEqual([...geom.toAlpha255(m)], [0, 255, 255, 0]);
});

test('countOn counts set pixels', () => {
  assert.equal(geom.countOn(new Uint8Array([1, 0, 1, 1, 0])), 3);
});

test('maskBbox returns the tight bounding box of set pixels', () => {
  const m = mask(5, 5, [[1, 1], [3, 1], [1, 3]]);
  assert.deepEqual(geom.maskBbox(m, 5, 5), { x: 1, y: 1, w: 3, h: 3 });
});

test('maskBbox returns null for an empty mask', () => {
  assert.equal(geom.maskBbox(new Uint8Array(9), 3, 3), null);
});

test('dilate grows a single pixel by the given radius', () => {
  const m = mask(5, 5, [[2, 2]]);
  const out = geom.dilate(m, 5, 5, 1);
  // 3x3 block centered on (2,2) should be on; corners of the 5x5 grid stay off.
  assert.equal(out[2 * 5 + 2], 1);
  assert.equal(out[1 * 5 + 1], 1);
  assert.equal(out[3 * 5 + 3], 1);
  assert.equal(out[0 * 5 + 0], 0);
});

test('connectedComponents groups adjacent pixels and respects minSize', () => {
  const W = 6, H = 3;
  const m = mask(W, H, [[0, 0], [1, 0], [4, 2]]); // one 2px component, one 1px component
  const comps = geom.connectedComponents(m, W, H, 2);
  assert.equal(comps.length, 1);
  assert.equal(comps[0].size, 2);
});

test('fillComp rebuilds an exact mask from a component', () => {
  const W = 4, H = 4;
  const m = mask(W, H, [[0, 0], [1, 0], [0, 1]]);
  const comps = geom.connectedComponents(m, W, H, 1);
  const out = new Uint8Array(W * H);
  geom.fillComp(out, comps[0]);
  assert.equal(geom.countOn(out), 3);
});

test('dominantColor picks the most common bucketed color', () => {
  // rgba: pixel 0 and 1 are red, pixel 2 is blue.
  const rgba = new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255]);
  const color = geom.dominantColor(rgba, [0, 1, 2]);
  assert.ok(color.r > color.b);
});

test('colorOfMask / medianColorOfMask return null-safe results for an empty mask', () => {
  const rgba = new Uint8Array(16);
  assert.equal(geom.medianColorOfMask(rgba, new Uint8Array(4)), null);
});

test('guessStyle classifies a wide low-roof house as ranch', () => {
  assert.equal(geom.guessStyle(400, 200, 0.02), 'ranch');
});

test('guessMaterial returns unknown for a null wall color', () => {
  assert.equal(geom.guessMaterial(null), 'unknown');
});

test('guessMaterial classifies a light low-saturation wall as render', () => {
  assert.equal(geom.guessMaterial({ r: 230, g: 228, b: 226 }), 'render');
});
