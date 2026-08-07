import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PREVIEW_DIM,
  computePreviewSize,
  buildPreviewCacheKey,
  createBoundedCache,
} from './schemePreviewCore.js';

// The AI Schemes crash was unbounded full-resolution preview processing. These
// tests pin the hard memory boundaries that make the panel safe to open: the
// preview dimensions are always clamped to MAX_PREVIEW_DIM and every cache is
// bounded, keyed by analysis/scheme identity so stale previews are never
// reused.
test('MAX_PREVIEW_DIM is bounded at 256', () => {
  assert.equal(MAX_PREVIEW_DIM, 256);
});

test('computePreviewSize leaves already-small images untouched', () => {
  assert.deepEqual(computePreviewSize(200, 120), { width: 200, height: 120 });
  assert.deepEqual(computePreviewSize(256, 256), { width: 256, height: 256 });
});

test('computePreviewSize clamps a 1600x1200 workspace to <=256 preserving aspect ratio', () => {
  const size = computePreviewSize(1600, 1200);
  assert.ok(size.width <= MAX_PREVIEW_DIM);
  assert.ok(size.height <= MAX_PREVIEW_DIM);
  assert.equal(size.width, 256);
  assert.equal(size.height, 192);
  // Aspect ratio preserved exactly (4:3).
  assert.equal(size.width / size.height, 1600 / 1200);
});

test('computePreviewSize clamps portrait and never returns zero', () => {
  const portrait = computePreviewSize(800, 2000);
  assert.ok(portrait.width >= 1 && portrait.height >= 1);
  assert.equal(Math.max(portrait.width, portrait.height), 256);
  const extreme = computePreviewSize(1, 100000);
  assert.equal(extreme.width, 1);
  assert.equal(extreme.height, 256);
});

test('preview cache key includes asset, scheme, analysis and size', () => {
  const key = buildPreviewCacheKey({ assetId: 'a1', schemeId: 's2', analysisId: 'j3', size: 256 });
  assert.equal(key, 'a1:s2:j3:256');
  // A different analysis (re-analyze) must never reuse the old preview.
  assert.notEqual(
    key,
    buildPreviewCacheKey({ assetId: 'a1', schemeId: 's2', analysisId: 'j9', size: 256 })
  );
  // Size is part of the identity too.
  assert.notEqual(
    key,
    buildPreviewCacheKey({ assetId: 'a1', schemeId: 's2', analysisId: 'j3', size: 128 })
  );
});

test('bounded cache never exceeds maxEntries', () => {
  const cache = createBoundedCache({ maxEntries: 3 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  cache.set('d', 4);
  assert.equal(cache.size, 3);
  assert.equal(cache.get('a'), undefined); // oldest evicted
  assert.equal(cache.get('d'), 4);
});

test('bounded cache get refreshes LRU order', () => {
  const cache = createBoundedCache({ maxEntries: 2 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a'); // touch 'a' so 'b' is now oldest
  cache.set('c', 3);
  assert.equal(cache.size, 2);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('b'), undefined);
});
