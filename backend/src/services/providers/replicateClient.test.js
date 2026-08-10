const test = require('node:test');
const assert = require('node:assert/strict');
const { runPrediction } = require('./replicateClient');

// HTTP mocked at the boundary (global.fetch) per the governing brief's
// "provider contract" testing requirement — no real network call, no
// REPLICATE_API_TOKEN needed. Verifies the version-resolution -> create ->
// poll -> terminal-state state machine and its failure modes (the exact
// request shape was itself corrected against the real API — see
// AI_HOSTED_VALIDATION_REPORT.md — this file locks that shape in).

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

const modelInfo = () => jsonResponse({ latest_version: { id: 'v1hash' } });

// Version resolution is cached per model name for the process lifetime (see
// replicateClient.js) — each test below therefore uses its own unique model
// name so its first call is always a genuine cache miss, matching
// withVersionResolution's assumption that the first fetch is the version GET.
function withVersionResolution(model, ...predictionResponses) {
  const infoUrl = `https://api.replicate.com/v1/models/${model}`;
  let call = 0;
  return async (url) => {
    if (String(url) === infoUrl) return modelInfo();
    return predictionResponses[call++];
  };
}

test('runPrediction throws without hitting the network when the token is missing', async (t) => {
  const fetchMock = t.mock.fn(async () => { throw new Error('should not be called'); });
  t.mock.method(globalThis, 'fetch', fetchMock);
  await assert.rejects(
    () => runPrediction({ token: '', model: 'owner/model', input: {}, providerName: 'replicate-vision' }),
    /REPLICATE_API_TOKEN is missing/
  );
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('runPrediction resolves the model version before creating a prediction, then resolves immediately on a terminal succeeded status', async (t) => {
  t.mock.method(globalThis, 'fetch', withVersionResolution(
    'owner/model-immediate',
    jsonResponse({ id: 'p1', status: 'succeeded', output: { detections: [] }, urls: { get: 'https://x/p1', cancel: 'https://x/p1/cancel' } })
  ));
  const output = await runPrediction({ token: 'tok', model: 'owner/model-immediate', input: {}, providerName: 'replicate-vision', pollIntervalMs: 1, pollTimeoutMs: 1000 });
  assert.deepEqual(output, { detections: [] });
});

test('runPrediction polls through intermediate statuses to succeeded', async (t) => {
  t.mock.method(globalThis, 'fetch', withVersionResolution(
    'owner/model-polling',
    jsonResponse({ id: 'p1', status: 'starting', urls: { get: 'https://x/p1' } }), // create
    jsonResponse({ id: 'p1', status: 'processing', urls: { get: 'https://x/p1' } }), // poll 1
    jsonResponse({ id: 'p1', status: 'succeeded', output: { ok: true }, urls: { get: 'https://x/p1' } }), // poll 2
  ));
  const output = await runPrediction({ token: 'tok', model: 'owner/model-polling', input: {}, providerName: 'replicate-vision', pollIntervalMs: 1, pollTimeoutMs: 1000 });
  assert.deepEqual(output, { ok: true });
});

test('runPrediction caches a resolved version, only resolving each distinct model once per process', async (t) => {
  let versionCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url) === 'https://api.replicate.com/v1/models/owner/cached-model') {
      versionCalls++;
      return modelInfo();
    }
    return jsonResponse({ id: 'p', status: 'succeeded', output: { n: versionCalls }, urls: { get: 'https://x/p' } });
  });
  await runPrediction({ token: 'tok', model: 'owner/cached-model', input: {}, providerName: 'replicate-vision', pollIntervalMs: 1, pollTimeoutMs: 1000 });
  await runPrediction({ token: 'tok', model: 'owner/cached-model', input: {}, providerName: 'replicate-vision', pollIntervalMs: 1, pollTimeoutMs: 1000 });
  assert.equal(versionCalls, 1);
});

test('runPrediction throws a ProviderError when the prediction fails', async (t) => {
  t.mock.method(globalThis, 'fetch', withVersionResolution(
    'owner/model-failed',
    jsonResponse({ id: 'p1', status: 'failed', error: 'model exploded', urls: { get: 'https://x/p1' } })
  ));
  await assert.rejects(
    () => runPrediction({ token: 'tok', model: 'owner/model-failed', input: {}, providerName: 'replicate-vision', pollIntervalMs: 1, pollTimeoutMs: 1000 }),
    /model exploded/
  );
});

test('runPrediction times out and best-effort cancels rather than polling forever', async (t) => {
  const model = 'owner/model-timeout';
  const infoUrl = `https://api.replicate.com/v1/models/${model}`;
  let cancelCalled = false;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url) === infoUrl) return modelInfo();
    if (String(url).endsWith('/cancel')) {
      cancelCalled = true;
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ id: 'p1', status: 'processing', urls: { get: 'https://x/p1', cancel: 'https://x/p1/cancel' } });
  });
  await assert.rejects(
    () => runPrediction({ token: 'tok', model, input: {}, providerName: 'replicate-vision', pollIntervalMs: 1, pollTimeoutMs: 5 }),
    /timed out/
  );
  assert.equal(cancelCalled, true);
});
