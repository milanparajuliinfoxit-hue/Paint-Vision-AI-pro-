const test = require('node:test');
const assert = require('node:assert/strict');
const provider = require('./replicateVisionProvider');

// Pure-logic tests only — no network, no REPLICATE_API_TOKEN needed. The
// real live model calls (adirik/grounding-dino, meta/sam-2) are verified
// separately once a token exists (see AI_HOSTED_ARCHITECTURE.md §5/§8); a
// unit test against canned detections/masks is a post-processing test, not
// "AI verification."

test('run() tags a missing-token failure with stage "config", not a generic/undefined stage', async () => {
  const saved = process.env.REPLICATE_API_TOKEN;
  delete process.env.REPLICATE_API_TOKEN;
  try {
    await assert.rejects(
      () => provider.run('house-understanding', { buffer: Buffer.from([]) }),
      (err) => {
        assert.match(err.message, /REPLICATE_API_TOKEN is missing/);
        assert.equal(err.stage, 'config');
        return true;
      }
    );
  } finally {
    if (saved !== undefined) process.env.REPLICATE_API_TOKEN = saved;
  }
});

test('filterDetections rejects an ambiguous merged-phrase label', () => {
  const out = provider.filterDetections([{ label: 'roof sky', confidence: 0.9, bbox: [0, 0, 10, 10] }]);
  assert.deepEqual(out, []);
});

test('filterDetections rejects a detection below its class threshold', () => {
  // "wall" threshold is 0.15 — 0.10 should be rejected.
  const out = provider.filterDetections([{ label: 'wall', confidence: 0.1, bbox: [0, 0, 10, 10] }]);
  assert.deepEqual(out, []);
});

test('filterDetections accepts an unambiguous, above-threshold detection', () => {
  const out = provider.filterDetections([{ label: 'door', confidence: 0.4, bbox: [1, 2, 3, 4] }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].class, 'door');
});

test('groupByClass buckets detections by their resolved class', () => {
  const grouped = provider.groupByClass([
    { class: 'wall', bbox: [0, 0, 1, 1] },
    { class: 'wall', bbox: [1, 1, 2, 2] },
    { class: 'door', bbox: [2, 2, 3, 3] },
  ]);
  assert.equal(grouped.wall.length, 2);
  assert.equal(grouped.door.length, 1);
});

test('rasterizeBoxes fills a rectangular region for each box, handling reversed coordinates', () => {
  const mask = provider.rasterizeBoxes([[3, 3, 1, 1]], 5, 5); // x1<x0, y1<y0
  assert.equal(mask[1 * 5 + 1], 1);
  assert.equal(mask[3 * 5 + 3], 1);
  assert.equal(mask[0 * 5 + 0], 0);
});

test('parseSamOutput returns null (triggering the bbox fallback) for an unrecognized output shape, without any network call', async () => {
  assert.equal(await provider.parseSamOutput({}, 10, 10), null);
  assert.equal(await provider.parseSamOutput('unexpected string', 10, 10), null);
  assert.equal(await provider.parseSamOutput([123], 10, 10), null); // array but not URLs
});

// --- buildAnalysis: the ported geometry post-processing -------------------

function rectMask(W, H, x0, x1, y0, y1) {
  const m = new Uint8Array(W * H);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) m[y * W + x] = 1;
  }
  return m;
}

function makeMasks(W, H) {
  return {
    roof: { mask: rectMask(W, H, 2, 17, 0, 3), confidence: 0.8 },
    wall: { mask: rectMask(W, H, 2, 17, 6, 17), confidence: 0.7 },
    window: { mask: rectMask(W, H, 5, 7, 8, 10), confidence: 0.6 },
    door: { mask: rectMask(W, H, 13, 15, 13, 17), confidence: 0.55 },
    sky: { mask: rectMask(W, H, 18, 19, 0, 1), confidence: 0.9 },
    ground: { mask: rectMask(W, H, 0, 19, 18, 19), confidence: 0.9 },
    tree: { mask: rectMask(W, H, 0, 0, 5, 5), confidence: 0.65 },
    car: { mask: rectMask(W, H, 0, 0, 10, 10), confidence: 0.6 },
    person: { mask: rectMask(W, H, 19, 19, 5, 5), confidence: 0.7 },
    fence: { mask: rectMask(W, H, 0, 0, 15, 15), confidence: 0.5 },
  };
}

function surfaceByKey(analysis, key) {
  return analysis.surfaces.find((s) => s.key === key);
}

test('buildAnalysis: house not present when roof/wall masks are empty', () => {
  const W = 20, H = 20, N = W * H;
  const empty = { mask: new Uint8Array(N), confidence: 0 };
  const masks = { roof: empty, wall: empty, window: empty, door: empty, sky: empty, ground: empty, tree: empty, car: empty, person: empty, fence: empty };
  const rgba = new Uint8Array(N * 4).fill(150);
  const analysis = provider.buildAnalysis({ masks, width: W, height: H, rgba, N, scale: 1 });
  assert.equal(analysis.house.present, false);
  assert.deepEqual(analysis.surfaces, []);
  assert.deepEqual(analysis.objects, []);
});

test('buildAnalysis: builds paintable surfaces, non-paintable windows, and removable objects for a present house', () => {
  const W = 20, H = 20, N = W * H;
  const masks = makeMasks(W, H);
  const rgba = new Uint8Array(N * 4).fill(150);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255; // opaque

  const analysis = provider.buildAnalysis({ masks, width: W, height: H, rgba, N, scale: 1 });

  assert.equal(analysis.house.present, true);
  assert.ok(analysis.house.confidence >= 0.3 && analysis.house.confidence <= 0.95);
  assert.ok(analysis.house.bbox);

  const keys = analysis.surfaces.map((s) => s.key);
  assert.ok(keys.includes('roof'));
  assert.ok(keys.includes('front-wall'));
  assert.ok(keys.includes('left-wall'));
  assert.ok(keys.includes('right-wall'));
  assert.ok(keys.includes('trim'));
  assert.ok(keys.includes('door'));
  assert.ok(keys.includes('windows'));

  const roof = surfaceByKey(analysis, 'roof');
  assert.equal(roof.paintable, true);
  assert.equal(roof.role, 'roof');

  const windows = surfaceByKey(analysis, 'windows');
  assert.equal(windows.paintable, false);
  assert.equal(windows.role, null);

  // Wall must exclude the window opening — a pixel inside the window rect
  // is on in the windows surface and off in front-wall.
  const wx = 6, wy = 9; // inside the window rect (5-7, 8-10)
  const frontWall = surfaceByKey(analysis, 'front-wall');
  assert.equal(windows.mask.alpha[wy * W + wx], 255);
  assert.equal(frontWall.mask.alpha[wy * W + wx], 0);

  const objectKeys = analysis.objects.map((o) => o.key);
  assert.deepEqual(objectKeys.sort(), ['car', 'fence', 'person', 'tree']);
  assert.ok(analysis.objects.every((o) => o.paintable === false));

  assert.ok(analysis.context.wallColor);
  assert.ok(analysis.context.roofColor);
});

test('buildAnalysis: roof geometric clamp bounds a mis-detected full-height roof to the top 45% of the house bbox', () => {
  const W = 20, H = 20, N = W * H;
  const empty = { mask: new Uint8Array(N), confidence: 0 };
  const masks = {
    ...{ window: empty, door: empty, sky: empty, ground: empty, tree: empty, car: empty, person: empty, fence: empty },
    roof: { mask: rectMask(W, H, 2, 17, 0, 17), confidence: 0.5 }, // wrongly boxes the whole building
    wall: empty,
  };
  const rgba = new Uint8Array(N * 4).fill(150);
  const analysis = provider.buildAnalysis({ masks, width: W, height: H, rgba, N, scale: 1 });

  const roof = surfaceByKey(analysis, 'roof');
  assert.ok(roof, 'roof surface should still be produced');
  // House bbox height is 18 (rows 0-17); clamp limit = round(18*0.45) = 8 rows.
  assert.ok(roof.geometry.bbox.h <= 8, `expected clamped roof height <= 8, got ${roof.geometry.bbox.h}`);
});
