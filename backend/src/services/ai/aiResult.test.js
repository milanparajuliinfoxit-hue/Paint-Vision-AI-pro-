const test = require('node:test');
const assert = require('node:assert/strict');
const aiResult = require('./aiResult');

test('ok() defaults stage to "completed" when the provider does not set one', () => {
  const result = aiResult.ok({ x: 1 }, { provider: 'catalog' });
  assert.equal(result.stage, 'completed');
});

test('fail() extracts stage/retryable off an Error the provider tagged (governing brief §17/§18)', () => {
  const err = new Error('timed out');
  err.stage = 'detect';
  err.retriable = true;
  const result = aiResult.fail(err, { provider: 'replicate-vision' });
  assert.equal(result.stage, 'detect');
  assert.equal(result.retryable, true);
  assert.equal(result.failureReason, 'timed out');
});

test('fail() defaults stage to null and retryable to false for a provider that never tags them', () => {
  const result = aiResult.fail(new Error('boom'), { provider: 'mock' });
  assert.equal(result.stage, null);
  assert.equal(result.retryable, false);
});

test('fail() accepts a plain string reason (not just an Error) without throwing', () => {
  const result = aiResult.fail('capability disabled', { provider: 'replicate-vision' });
  assert.equal(result.failureReason, 'capability disabled');
  assert.equal(result.stage, null);
  assert.equal(result.retryable, false);
});

test('fail() lets explicit meta.stage/meta.retryable override the error object\'s own fields', () => {
  const err = new Error('x');
  err.stage = 'detect';
  const result = aiResult.fail(err, { provider: 'p', stage: 'normalize', retryable: true });
  assert.equal(result.stage, 'normalize');
  assert.equal(result.retryable, true);
});
