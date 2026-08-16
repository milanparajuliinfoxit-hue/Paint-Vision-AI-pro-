const test = require('node:test');
const assert = require('node:assert/strict');
const { box2dToPixels, polygonToPixels, rasterizePolygon, rasterizeBox } = require('./polygonMask.util');

test('box2dToPixels converts a normalized [x0,y0,x1,y1] box to pixel space (asymmetric, so order actually matters)', () => {
  assert.deepEqual(box2dToPixels([100, 200, 900, 400], 100, 100), { x0: 10, y0: 20, x1: 90, y1: 40 });
});

// Regression: a real gemini-3.6-flash call (2026-08-11) returned
// box_2d=[583,537,822,563] for a "pillar" detection whose own `mask`
// polygon had x in {583,822} and y in {537,563} — confirming box_2d is
// [x0,y0,x1,y1], not the [ymin,xmin,ymax,xmax] ai.google.dev's prose
// describes. This is real observed API behavior, not a synthetic case.
test('box2dToPixels matches a real observed Gemini response (pillar detection, 2026-08-11)', () => {
  const result = box2dToPixels([583, 537, 822, 563], 1000, 1000);
  assert.deepEqual(result, { x0: 583, y0: 537, x1: 822, y1: 563 });
});

test('box2dToPixels returns null for a malformed box', () => {
  assert.equal(box2dToPixels([1, 2, 3], 100, 100), null);
  assert.equal(box2dToPixels(null, 100, 100), null);
});

test('polygonToPixels scales normalized points into pixel space and requires >= 3 points', () => {
  const pts = polygonToPixels([[0, 0], [500, 0], [500, 500]], 100, 100);
  assert.deepEqual(pts, [[0, 0], [50, 0], [50, 50]]);
  assert.equal(polygonToPixels([[0, 0], [1, 1]], 100, 100), null);
});

test('rasterizePolygon fills exactly the enclosed pixels for an axis-aligned square', () => {
  const poly = polygonToPixels([[300, 300], [700, 300], [700, 700], [300, 700]], 100, 100);
  const mask = rasterizePolygon(poly, 100, 100);
  let on = 0;
  for (const v of mask) if (v) on += 1;
  // 40x40 square (pixels 30..69 inclusive on both axes) = 1600
  assert.equal(on, 1600);
});

test('rasterizePolygon returns an all-zero mask for fewer than 3 points', () => {
  const mask = rasterizePolygon([[0, 0], [1, 1]], 10, 10);
  assert.equal(mask.length, 100);
  assert.ok(mask.every((v) => v === 0));
});

test('rasterizeBox fills the given box and clamps to image bounds', () => {
  const mask = rasterizeBox({ x0: -5, y0: -5, x1: 200, y1: 200 }, 10, 10);
  assert.equal(mask.length, 100);
  assert.ok(mask.every((v) => v === 1)); // clamped box covers the whole 10x10 image
});
