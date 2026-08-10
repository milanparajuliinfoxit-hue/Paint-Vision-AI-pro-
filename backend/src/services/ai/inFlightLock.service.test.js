const test = require('node:test');
const assert = require('node:assert/strict');
const { withLock } = require('./inFlightLock.service');

test('two concurrent calls for the same key run the work exactly once and both get the same result', async () => {
  let calls = 0;
  const work = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { value: calls };
  };

  const [a, b] = await Promise.all([withLock('k1', work), withLock('k1', work)]);
  assert.equal(calls, 1);
  assert.equal(a, b); // same object identity — the second caller got the first's in-flight promise
});

test('different keys run independently (no cross-key blocking)', async () => {
  let calls = 0;
  const work = async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return calls; };

  await Promise.all([withLock('a', work), withLock('b', work)]);
  assert.equal(calls, 2);
});

test('a call after the first one settles runs the work again (not permanently locked)', async () => {
  let calls = 0;
  const work = async () => { calls++; return calls; };

  const first = await withLock('k2', work);
  const second = await withLock('k2', work);
  assert.equal(first, 1);
  assert.equal(second, 2);
});

test('a rejected call still releases the lock for the next caller', async () => {
  let attempt = 0;
  const work = async () => {
    attempt++;
    if (attempt === 1) throw new Error('first attempt fails');
    return 'ok';
  };

  await assert.rejects(() => withLock('k3', work), /first attempt fails/);
  const result = await withLock('k3', work);
  assert.equal(result, 'ok');
});
