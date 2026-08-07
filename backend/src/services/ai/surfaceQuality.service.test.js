const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreSurface, QUALITY_THRESHOLD } = require('./surfaceQuality.service');

// A well-formed roof: plausible area, fully inside the house bbox, no
// object overlap, reasonable aspect ratio, decent confidence.
function goodRoof() {
  return {
    key: 'roof',
    confidence: 0.8,
    mask: { alpha: new Uint8Array(400).fill(255) },
    geometry: { bbox: { x: 10, y: 10, w: 80, h: 20 }, areaRatio: 0.1 },
  };
}

const houseBbox = { x: 0, y: 0, w: 100, h: 100 };
const ctx = { houseBbox, width: 100, height: 100, objectMasks: [] };

test('a plausible, well-contained surface scores above the quality threshold', () => {
  const result = scoreSurface(goodRoof(), ctx);
  assert.ok(result.score >= QUALITY_THRESHOLD, `expected >= ${QUALITY_THRESHOLD}, got ${result.score}`);
  assert.equal(result.tier, 'good');
});

test('a door sized like the whole wall scores low on area plausibility', () => {
  const hugeDoor = {
    key: 'door',
    confidence: 0.9, // even with high model confidence...
    mask: { alpha: new Uint8Array(400).fill(255) },
    geometry: { bbox: { x: 0, y: 0, w: 100, h: 100 }, areaRatio: 0.9 }, // ...90% of the image is not a door
  };
  const result = scoreSurface(hugeDoor, ctx);
  assert.ok(result.breakdown.area < 0.3, `expected a low area score, got ${result.breakdown.area}`);
});

test('a surface mostly outside the house bbox scores low on containment', () => {
  const offHouse = {
    key: 'trim',
    confidence: 0.8,
    mask: { alpha: new Uint8Array(400).fill(255) },
    geometry: { bbox: { x: 200, y: 200, w: 20, h: 20 }, areaRatio: 0.04 }, // entirely outside houseBbox
  };
  const result = scoreSurface(offHouse, ctx);
  assert.equal(result.breakdown.houseContainment, 0);
});

test('a surface substantially overlapping a detected object scores low on object exclusion', () => {
  const treeMask = { alpha: new Uint8Array(400).fill(255) }; // "tree" covers the whole frame
  const surface = {
    key: 'front-wall',
    confidence: 0.8,
    mask: { alpha: new Uint8Array(400).fill(255) }, // fully overlapping the tree mask
    geometry: { bbox: { x: 0, y: 0, w: 20, h: 20 }, areaRatio: 0.04 },
  };
  const result = scoreSurface(surface, { ...ctx, objectMasks: [treeMask] });
  assert.equal(result.breakdown.objectExclusion, 0);
});

test('an extreme sliver bbox scores low on aspect ratio', () => {
  const sliver = {
    key: 'trim',
    confidence: 0.8,
    mask: { alpha: new Uint8Array(400).fill(255) },
    geometry: { bbox: { x: 0, y: 0, w: 100, h: 1 }, areaRatio: 0.01 },
  };
  const result = scoreSurface(sliver, ctx);
  assert.ok(result.breakdown.aspectRatio < 0.5, `expected a low aspect score, got ${result.breakdown.aspectRatio}`);
});

test('score is always within [0, 1]', () => {
  const worst = {
    key: 'door',
    confidence: 0,
    mask: { alpha: new Uint8Array(400).fill(255) },
    geometry: { bbox: { x: 500, y: 500, w: 1, h: 500 }, areaRatio: 0.99 },
  };
  const result = scoreSurface(worst, { ...ctx, objectMasks: [{ alpha: new Uint8Array(400).fill(255) }] });
  assert.ok(result.score >= 0 && result.score <= 1);
  assert.equal(result.tier, 'low');
});
