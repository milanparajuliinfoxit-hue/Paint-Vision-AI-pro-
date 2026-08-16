import { test } from 'node:test';
import assert from 'node:assert/strict';

// mergeMasks (exercised below via real subtract scenarios) constructs a real
// `new ImageData(w, h)` internally — a browser API this plain-Node test
// suite doesn't have. Minimal test-only shim, not a new runtime dependency.
if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.data = new Uint8ClampedArray(width * height * 4);
    }
  };
}

const { isMaskEmpty, masksOverlap, mergeMasks, unionAlphaGrids, isPointInsideAlpha, canEnterFloodFillPixel, countMaskPixels, closeSmallHoles, computeFloodFillGrids } = await import('./maskOps.js');

// isMaskEmpty/masksOverlap only ever read `.data` (an RGBA byte array) —
// plain objects shaped like that are enough here, no real ImageData/DOM
// needed (this suite runs in plain Node, same as the rest of this package).
function fakeMask(alphaValues) {
  const data = new Uint8ClampedArray(alphaValues.length * 4);
  alphaValues.forEach((a, i) => { data[i * 4 + 3] = a; });
  return { width: alphaValues.length, height: 1, data };
}

test('isMaskEmpty is true for an all-zero-alpha mask', () => {
  assert.equal(isMaskEmpty(fakeMask([0, 0, 0, 0])), true);
});

test('isMaskEmpty is false if any pixel has meaningful (above-floor) alpha', () => {
  assert.equal(isMaskEmpty(fakeMask([0, 0, 50, 0])), false);
  assert.equal(isMaskEmpty(fakeMask([255, 0, 0, 0])), false);
});

// Regression test for the real reported bug: a fully-erased layer never
// auto-deleted because the eraser's own stroke used to be feathered (soft
// alpha falloff at its edge), so mergeMasks' subtract could never reach
// *exact* zero even when the user erased well past the painted region —
// isMaskEmpty's near-zero floor absorbs that class of residue (canvas
// anti-aliasing, sub-pixel rendering) without weakening the check for a
// layer that still has real paint on it.
test('isMaskEmpty tolerates near-zero rendering residue but not real remaining paint', () => {
  assert.equal(isMaskEmpty(fakeMask([1, 2, 3])), true, 'sub-pixel-noise-level alpha must count as empty');
  assert.equal(isMaskEmpty(fakeMask([4])), false, 'anything clearly above the noise floor must not be treated as empty');
  assert.equal(isMaskEmpty(fakeMask([0, 0, 0, 8, 0])), false, 'one real residual pixel among otherwise-empty ones is still not empty');
});

test('isMaskEmpty on a real subtract result: full coverage erase leaves nothing', () => {
  const base = fakeMask([255, 200, 100]);
  const stroke = fakeMask([255, 255, 255]); // erases at least as much as exists everywhere
  assert.equal(isMaskEmpty(mergeMasks(base, stroke, 'subtract')), true);
});

test('isMaskEmpty on a real subtract result: partial coverage leaves a residual pixel', () => {
  const base = fakeMask([255, 200, 100]);
  const stroke = fakeMask([255, 50, 0]); // middle/last pixel not fully covered
  const merged = mergeMasks(base, stroke, 'subtract');
  assert.equal(isMaskEmpty(merged), false);
  assert.deepEqual([merged.data[3], merged.data[7], merged.data[11]], [0, 150, 100]);
});

test('masksOverlap is true only where both masks have paint at the same pixel', () => {
  const a = fakeMask([255, 0, 255]);
  const b = fakeMask([0, 255, 0]);
  assert.equal(masksOverlap(a, b), false, 'no shared pixel has paint in both');

  const c = fakeMask([0, 0, 255]);
  assert.equal(masksOverlap(a, c), true, 'last pixel has paint in both a and c');
});

test('masksOverlap is false for two fully empty masks', () => {
  assert.equal(masksOverlap(fakeMask([0, 0, 0]), fakeMask([0, 0, 0])), false);
});

// --- Magic Wand house-aware selection ---------------------------------
// floodFillMask itself needs a real canvas (featherMask) to run end-to-end,
// so these test the actual house-aware *decision* logic it's built on —
// canEnterFloodFillPixel — directly, DOM-free.

test('unionAlphaGrids takes the per-pixel max across multiple surface grids', () => {
  const wall = new Uint8Array([255, 0, 0, 0]);
  const roof = new Uint8Array([0, 255, 0, 0]);
  const trim = new Uint8Array([0, 0, 0, 128]);
  assert.deepEqual(Array.from(unionAlphaGrids([wall, roof, trim])), [255, 255, 0, 128]);
});

test('unionAlphaGrids returns null when there are no real grids to union', () => {
  assert.equal(unionAlphaGrids([]), null);
  assert.equal(unionAlphaGrids([null, undefined]), null);
});

test('isPointInsideAlpha: true only where the grid value meets the threshold', () => {
  const grid = new Uint8Array([255, 0, 200]);
  assert.equal(isPointInsideAlpha(grid, 3, 1, 0, 0), true);
  assert.equal(isPointInsideAlpha(grid, 3, 1, 1, 0), false);
  assert.equal(isPointInsideAlpha(grid, 3, 1, 2, 0, 210), false, 'below the given threshold is outside');
});

test('isPointInsideAlpha: out-of-bounds coordinates are always outside', () => {
  const grid = new Uint8Array([255]);
  assert.equal(isPointInsideAlpha(grid, 1, 1, -1, 0), false);
  assert.equal(isPointInsideAlpha(grid, 1, 1, 1, 0), false);
});

// 1. Color similarity alone still gates entry (the pre-existing behavior).
test('canEnterFloodFillPixel: rejects a neighbor whose color is outside the seed tolerance', () => {
  const seedLab = { l: 50, a: 0, b: 0 };
  const result = canEnterFloodFillPixel({
    neighborLab: { l: 90, a: 0, b: 0 }, seedLab, fromLab: seedLab, tolerance: 20, stepTolerance: 14,
  });
  assert.equal(result, false);
});

// 2. THE reported bug, reproduced directly: a wall pixel and a sky pixel
// that are close enough to each other to be within the same broad seed
// tolerance must still be rejected by the *step* check, because the jump
// between the two adjacent pixels (the boundary itself) is bigger than the
// gradual shading inside either surface.
test('canEnterFloodFillPixel: a same-tolerance-bucket boundary pixel is rejected by the step check (house/sky bleed)', () => {
  const seedLab = { l: 55, a: -2, b: -8 }; // house wall, slightly blue-grey
  const fromLab = { l: 54, a: -2, b: -7 }; // the wall pixel immediately before the boundary
  const skyLab = { l: 70, a: -3, b: -18 }; // sky — within 20 of the wall seed overall, but a big step from `fromLab`
  const distFromSeed = Math.sqrt((skyLab.l - seedLab.l) ** 2 + (skyLab.a - seedLab.a) ** 2 + (skyLab.b - seedLab.b) ** 2);
  assert.ok(distFromSeed < 20, 'the two colors must genuinely be within the same broad tolerance for this test to be meaningful');
  const result = canEnterFloodFillPixel({ neighborLab: skyLab, seedLab, fromLab, tolerance: 20, stepTolerance: 14 });
  assert.equal(result, false);
});

// 3. Gradual shading *within* one surface (small step, small seed distance)
// must keep passing — the fix must not make Magic Wand unusably strict.
test('canEnterFloodFillPixel: gradual same-surface shading still passes', () => {
  const seedLab = { l: 55, a: -2, b: -8 };
  const fromLab = { l: 56, a: -2, b: -8 };
  const neighborLab = { l: 57, a: -2, b: -7 };
  const result = canEnterFloodFillPixel({ neighborLab, seedLab, fromLab, tolerance: 20, stepTolerance: 14 });
  assert.equal(result, true);
});

// 4. House-boundary restriction: even a pixel that is a perfect color match
// (zero distance, zero step) must never be entered once it falls outside
// the detected house region — this is the actual environment-protection
// mechanism (sky/ground/neighboring-building exclusion all reduce to this
// same check once each region has its own houseAlphaValue).
test('canEnterFloodFillPixel: perfect color match is still rejected outside the house mask', () => {
  const lab = { l: 50, a: 0, b: 0 };
  const result = canEnterFloodFillPixel({
    neighborLab: lab, seedLab: lab, fromLab: lab, tolerance: 20, stepTolerance: 14,
    houseAlphaValue: 0, houseAlphaThreshold: 32,
  });
  assert.equal(result, false);
});

test('canEnterFloodFillPixel: passes once the house mask value meets the threshold', () => {
  const lab = { l: 50, a: 0, b: 0 };
  const result = canEnterFloodFillPixel({
    neighborLab: lab, seedLab: lab, fromLab: lab, tolerance: 20, stepTolerance: 14,
    houseAlphaValue: 200, houseAlphaThreshold: 32,
  });
  assert.equal(result, true);
});

// 5. No house mask available at all (no AI analysis run yet) — must not
// block anything by itself; color/step tolerance remain the only gates.
test('canEnterFloodFillPixel: absent house mask never blocks (color/step tolerance still apply)', () => {
  const seedLab = { l: 50, a: 0, b: 0 };
  const result = canEnterFloodFillPixel({
    neighborLab: seedLab, seedLab, fromLab: seedLab, tolerance: 20, stepTolerance: 14, houseAlphaValue: undefined,
  });
  assert.equal(result, true);
});

test('countMaskPixels counts only pixels with nonzero alpha', () => {
  assert.equal(countMaskPixels(fakeMask([0, 255, 0, 128, 0])), 2);
  assert.equal(countMaskPixels(fakeMask([0, 0, 0])), 0);
});

// --- Magic Wand hole-closing (the fix for "patches of original paint
// remaining") -----------------------------------------------------------
// A minimal 1-channel LAB stand-in (color value lives entirely in `r`, with
// `g`/`b` unused) keeps these tests deterministic without importing the real
// sRGB->LAB math — closeSmallHoles/computeFloodFillGrids only ever call
// rgbToLab and compare the numbers it returns, so any consistent metric
// exercises the same logic paths as the real color space would.
const fakeRgbToLab = (r) => ({ l: r, a: 0, b: 0 });

function buildFlatImage(width, height, baseR) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = baseR;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data, setR: (x, y, r) => { data[(y * width + x) * 4] = r; } };
}

test('closeSmallHoles fills a single noise pixel fully surrounded by selection and color-plausible', () => {
  const width = 5, height = 5;
  // Every pixel selected except the center one.
  const raw = new Uint8Array(width * height).fill(255);
  raw[2 * width + 2] = 0;
  const img = buildFlatImage(width, height, 200);
  img.setR(2, 2, 185); // deviates 15 from the wall reference — within the loosened tolerance below
  const refLab = fakeRgbToLab(200);
  const closed = closeSmallHoles(raw, width, height, img.data, refLab, fakeRgbToLab, 10); // loosened = 10*1.6 = 16
  assert.equal(closed[2 * width + 2], 255, 'isolated, color-plausible hole must be closed');
});

test('closeSmallHoles never fills a hole whose color is implausible even when fully surrounded', () => {
  const width = 5, height = 5;
  const raw = new Uint8Array(width * height).fill(255);
  raw[2 * width + 2] = 0;
  const img = buildFlatImage(width, height, 200);
  img.setR(2, 2, 0); // wildly different — a screw, a crack, real detail, not noise
  const refLab = fakeRgbToLab(200);
  const closed = closeSmallHoles(raw, width, height, img.data, refLab, fakeRgbToLab, 10);
  assert.equal(closed[2 * width + 2], 0, 'implausible-colored pixel must stay excluded regardless of surrounding selection');
});

test('closeSmallHoles never fills a large unselected region even where its border touches selection', () => {
  const width = 9, height = 9;
  const raw = new Uint8Array(width * height).fill(255);
  // A solid 3x3 unselected block (stand-in for a window) — every one of its
  // pixels borders mostly other unselected block pixels, not selection.
  for (let y = 3; y <= 5; y++) for (let x = 3; x <= 5; x++) raw[y * width + x] = 0;
  const img = buildFlatImage(width, height, 200);
  const refLab = fakeRgbToLab(200);
  const closed = closeSmallHoles(raw, width, height, img.data, refLab, fakeRgbToLab, 10);
  for (let y = 3; y <= 5; y++) {
    for (let x = 3; x <= 5; x++) {
      assert.equal(closed[y * width + x], 0, `block pixel (${x},${y}) must not be bridged by hole-closing`);
    }
  }
});

test('computeFloodFillGrids: raw fill leaves a noise hole; closedGrid fills it but leaves a real feature (window) alone', () => {
  const width = 9, height = 9;
  const img = buildFlatImage(width, height, 200);
  img.setR(4, 4, 185); // single noisy wall pixel, deviation 15
  for (let y = 2; y <= 4; y++) for (let x = 6; x <= 8; x++) img.setR(x, y, 0); // "window" block, deviation 200

  const { rawGrid, closedGrid } = computeFloodFillGrids(img, 0, 0, 10, fakeRgbToLab, {});

  assert.equal(rawGrid[4 * width + 4], 0, 'the noisy pixel fails the strict connectivity fill and is a raw hole');
  assert.equal(closedGrid[4 * width + 4], 255, 'hole-closing recovers the isolated, color-plausible noise pixel');

  // The window block must never be selected in either stage.
  for (let y = 2; y <= 4; y++) {
    for (let x = 6; x <= 8; x++) {
      assert.equal(rawGrid[y * width + x], 0, `window pixel (${x},${y}) must not be in the raw fill`);
      assert.equal(closedGrid[y * width + x], 0, `window pixel (${x},${y}) must not be bridged into the closed selection`);
    }
  }

  // The rest of the flat wall is fully selected in both stages.
  assert.equal(rawGrid[0], 255);
  assert.equal(closedGrid[0], 255);
});
