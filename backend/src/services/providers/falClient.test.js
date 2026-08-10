const test = require('node:test');
const assert = require('node:assert/strict');
const { runModel } = require('./falClient');

// HTTP mocked at the boundary (global.fetch) — no real network call, no
// FAL_API_KEY needed. Verifies the submit -> poll -> COMPLETED/ERROR state
// machine against the contract confirmed from fal's own JS client source
// (see falClient.js's header) — the request/response shapes here are
// evidence-based, not guessed.

function jsonResponse(obj, { ok = true, status = 200 } = {}) {
  const text = JSON.stringify(obj);
  return {
    ok,
    status,
    headers: { get: () => null },
    json: async () => obj,
    text: async () => text,
    arrayBuffer: async () => Buffer.from(text, 'utf8'),
  };
}

test('runModel throws without hitting the network when the API key is missing', async (t) => {
  const fetchMock = t.mock.fn(async () => { throw new Error('should not be called'); });
  t.mock.method(globalThis, 'fetch', fetchMock);
  await assert.rejects(
    () => runModel({ apiKey: '', model: 'fal-ai/sam-3/image', input: {}, providerName: 'fal-vision' }),
    /FAL_API_KEY is missing/
  );
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('runModel sends the raw input as the POST body (not wrapped in {input}), with fal\'s "Key" auth scheme, and resolves immediately on a COMPLETED submission', async (t) => {
  let call = 0;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    call++;
    if (call === 1) {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Key tok');
      assert.deepEqual(JSON.parse(options.body), { prompt: 'roof' });
      return jsonResponse({ request_id: 'r1', status: 'COMPLETED', response_url: 'https://x/result' });
    }
    if (String(url) === 'https://x/result') return jsonResponse({ masks: [], scores: [] });
    throw new Error('unexpected fetch call: ' + url);
  });
  const output = await runModel({ apiKey: 'tok', model: 'fal-ai/sam-3/image', input: { prompt: 'roof' }, providerName: 'fal-vision', pollIntervalMs: 1, pollTimeoutMs: 1000 });
  assert.deepEqual(output, { masks: [], scores: [] });
});

test('runModel polls through IN_QUEUE/IN_PROGRESS to COMPLETED', async (t) => {
  const responses = [
    jsonResponse({ request_id: 'r1', status: 'IN_QUEUE', status_url: 'https://x/status', response_url: 'https://x/result' }), // submit
    jsonResponse({ status: 'IN_PROGRESS' }), // poll 1
    jsonResponse({ status: 'COMPLETED' }), // poll 2
    jsonResponse({ ok: true }), // result fetch
  ];
  let call = 0;
  t.mock.method(globalThis, 'fetch', async () => responses[call++]);
  const output = await runModel({ apiKey: 'tok', model: 'fal-ai/sam-3/image', input: {}, providerName: 'fal-vision', pollIntervalMs: 1, pollTimeoutMs: 1000 });
  assert.deepEqual(output, { ok: true });
  assert.equal(call, 4);
});

test('runModel throws a ProviderError when the request ends with status ERROR', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    jsonResponse({ request_id: 'r1', status: 'ERROR', status_url: 'https://x/status', response_url: 'https://x/result' })
  );
  await assert.rejects(
    () => runModel({ apiKey: 'tok', model: 'fal-ai/sam-3/image', input: {}, providerName: 'fal-vision', pollIntervalMs: 1, pollTimeoutMs: 1000 }),
    /ended with status ERROR/
  );
});

test('runModel times out and best-effort cancels (PUT) rather than polling forever', async (t) => {
  let cancelCalled = false;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (options.method === 'PUT') {
      cancelCalled = true;
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ request_id: 'r1', status: 'IN_PROGRESS', status_url: 'https://x/status', response_url: 'https://x/result', cancel_url: 'https://x/cancel' });
  });
  await assert.rejects(
    () => runModel({ apiKey: 'tok', model: 'fal-ai/sam-3/image', input: {}, providerName: 'fal-vision', pollIntervalMs: 1, pollTimeoutMs: 5 }),
    /timed out/
  );
  assert.equal(cancelCalled, true);
});
