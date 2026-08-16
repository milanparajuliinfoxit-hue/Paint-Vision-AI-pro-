const test = require('node:test');
const assert = require('node:assert/strict');
const { CATEGORIES, isValidCategory, labelFor } = require('./architecturalCategories');

test('CATEGORIES is a non-empty fixed list, every entry has a key and label', () => {
  assert.ok(CATEGORIES.length > 0);
  for (const c of CATEGORIES) {
    assert.equal(typeof c.key, 'string');
    assert.equal(typeof c.label, 'string');
    assert.ok(c.key.length > 0 && c.label.length > 0);
  }
});

test('isValidCategory accepts every key in CATEGORIES', () => {
  for (const c of CATEGORIES) assert.equal(isValidCategory(c.key), true);
});

test('isValidCategory rejects an arbitrary/invented key (no detected-surface class_key is ever valid here)', () => {
  assert.equal(isValidCategory('front-wall'), false);
  assert.equal(isValidCategory('windows-3'), false);
  assert.equal(isValidCategory(''), false);
  assert.equal(isValidCategory(undefined), false);
  assert.equal(isValidCategory(null), false);
});

test('labelFor returns the real label for a known key, and the key itself as a safe fallback', () => {
  assert.equal(labelFor('primary-wall'), 'Primary Wall');
  assert.equal(labelFor('not-a-category'), 'not-a-category');
});
