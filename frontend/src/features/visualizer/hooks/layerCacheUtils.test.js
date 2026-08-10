import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertById } from './layerCacheUtils.js';

// Regression test: useCreateLayer's onSuccess also backs the AI-surface
// idempotent upsert path (useApplySurface.js), where the server response
// can be an *update* to an already-cached layer, not a new one. A blind
// append would leave a stale duplicate sitting alongside the update.
test('upsertById appends a genuinely new id', () => {
  const list = [{ id: 1, name: 'A' }];
  const result = upsertById(list, { id: 2, name: 'B' });
  assert.deepEqual(result, [{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);
});

test('upsertById replaces an existing id in place, not appending a duplicate', () => {
  const list = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }];
  const result = upsertById(list, { id: 2, name: 'B-updated' });
  assert.equal(result.length, 3);
  assert.deepEqual(result, [{ id: 1, name: 'A' }, { id: 2, name: 'B-updated' }, { id: 3, name: 'C' }]);
});

test('upsertById does not mutate the original list', () => {
  const list = [{ id: 1, name: 'A' }];
  const original = [...list];
  upsertById(list, { id: 1, name: 'A-updated' });
  assert.deepEqual(list, original);
});

test('upsertById on an empty list just appends', () => {
  assert.deepEqual(upsertById([], { id: 1, name: 'A' }), [{ id: 1, name: 'A' }]);
});
