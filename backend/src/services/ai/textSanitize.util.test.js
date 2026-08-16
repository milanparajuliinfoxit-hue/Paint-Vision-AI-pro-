const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeUserIntent, MAX_INTENT_LENGTH } = require('./textSanitize.util');

test('sanitizeUserIntent strips control characters and collapses whitespace', () => {
  assert.equal(sanitizeUserIntent('  Make it   warm\tand \x01\x02cozy  '), 'Make it warm and cozy');
});

test('sanitizeUserIntent hard-caps at MAX_INTENT_LENGTH characters', () => {
  const result = sanitizeUserIntent('x'.repeat(1000));
  assert.equal(result.length, MAX_INTENT_LENGTH);
});

test('sanitizeUserIntent accepts a custom max length', () => {
  assert.equal(sanitizeUserIntent('abcdefghij', 5), 'abcde');
});

test('sanitizeUserIntent returns empty string for non-string input, never throws', () => {
  assert.equal(sanitizeUserIntent(null), '');
  assert.equal(sanitizeUserIntent(undefined), '');
  assert.equal(sanitizeUserIntent(42), '');
  assert.equal(sanitizeUserIntent({}), '');
});

test('sanitizeUserIntent trims leading/trailing whitespace after collapsing', () => {
  assert.equal(sanitizeUserIntent('   hello world   '), 'hello world');
});
