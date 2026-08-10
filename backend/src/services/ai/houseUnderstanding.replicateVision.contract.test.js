const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const Jimp = require('jimp');

// CONTRACT TEST — Replicate's HTTP boundary is fully mocked (global.fetch).
// This proves the *wiring* — replicate-vision's detect->segment->normalize
// output flows correctly through the existing, provider-agnostic
// houseUnderstanding.service.js persistence path into real detected_surfaces
// /detected_objects rows and real mask files, and that the existing
// cleanup-mask connector (objectRemovalMask.service.js) consumes it
// correctly. It is NOT a claim about real segmentation quality — the mask
// pixels returned by the mock are fake/uniform. Real quality can only be
// judged from a live Replicate call (blocked on account credit as of this
// writing — see AI_HOSTED_VALIDATION_REPORT.md). Do not read this test's
// pass as "the AI works well on real photos."
//
// Env vars are set before any require() — same convention as
// storage.service.test.js's UPLOAD_ROOT trick — so this test is
// self-contained and doesn't depend on backend/.env's current values.
const scratchRoot = path.join(__dirname, '..', '__test_uploads_replicate_contract__');
process.env.UPLOAD_ROOT = scratchRoot;
process.env.AI_ANALYSIS_ENABLED = 'true';
process.env.AI_ANALYSIS_PROVIDER = 'replicate-vision';
process.env.REPLICATE_API_TOKEN = 'test-fake-token';
process.env.REPLICATE_DINO_MODEL = 'adirik/grounding-dino';
process.env.REPLICATE_SAM_MODEL = 'meta/sam-2';
process.env.AI_ANALYSIS_MAX_DIM = '640';

const pool = require('../../config/db');
const projectsModel = require('../projects.model');
const assetsModel = require('../assets.model');
const storage = require('../storage.service');
const houseUnderstanding = require('./houseUnderstanding.service');
const objectRemovalMask = require('./objectRemovalMask.service');

const MASK_URL = 'https://fake.replicate.delivery/mask.png';

const W = 100, H = 80; // small enough that AI_ANALYSIS_MAX_DIM never downscales — bbox math below assumes no scaling.

function jsonResponse(obj) {
  const text = JSON.stringify(obj);
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => obj, text: async () => text, arrayBuffer: async () => Buffer.from(text, 'utf8') };
}
function binaryResponse(buf) {
  return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => buf, text: async () => buf.toString('utf8') };
}

// roof/wall/tree score above their class thresholds (0.20/0.15/0.30);
// window/door/car/person/fence/sky/ground get no detections, exercising the
// "no items for this class -> empty mask, source:'none'" path too.
const FAKE_DETECTIONS = [
  { label: 'roof', confidence: 0.5, bbox: [10, 0, 90, 20] },
  { label: 'wall', confidence: 0.6, bbox: [10, 20, 90, 70] },
  { label: 'tree', confidence: 0.7, bbox: [0, 50, 10, 80] },
  { label: 'roof sky', confidence: 0.9, bbox: [0, 0, 100, 80] }, // ambiguous merged phrase — must be rejected, not attributed to roof
];

let dinoVersionCalls = 0;
let samVersionCalls = 0;
let dinoCreateCalls = 0;
let samCreateCalls = 0;

let TINY_PNG; // a real, fully-decodable opaque PNG — generated in test.before, not hand-typed base64 (which turned out to be truncated/corrupt and only passed multer's magic-byte sniff, not Jimp's full decode)

async function fakeFetch(url, options = {}) {
  const method = options.method || 'GET';
  const urlStr = String(url);

  if (method === 'GET' && urlStr === 'https://api.replicate.com/v1/models/adirik/grounding-dino') {
    dinoVersionCalls++;
    return jsonResponse({ latest_version: { id: 'dino-v1' } });
  }
  if (method === 'GET' && urlStr === 'https://api.replicate.com/v1/models/meta/sam-2') {
    samVersionCalls++;
    return jsonResponse({ latest_version: { id: 'sam-v1' } });
  }
  if (method === 'POST' && urlStr === 'https://api.replicate.com/v1/predictions') {
    const body = JSON.parse(options.body);
    if (body.version === 'dino-v1') {
      dinoCreateCalls++;
      return jsonResponse({ id: 'p-dino-' + dinoCreateCalls, status: 'succeeded', output: { detections: FAKE_DETECTIONS }, urls: { get: 'https://api.replicate.com/v1/predictions/p-dino' } });
    }
    if (body.version === 'sam-v1') {
      samCreateCalls++;
      return jsonResponse({ id: 'p-sam-' + samCreateCalls, status: 'succeeded', output: [MASK_URL], urls: { get: 'https://api.replicate.com/v1/predictions/p-sam' } });
    }
    throw new Error('unexpected prediction version: ' + body.version);
  }
  if (method === 'GET' && urlStr === MASK_URL) {
    return binaryResponse(TINY_PNG);
  }
  throw new Error('unexpected fetch call: ' + method + ' ' + urlStr);
}

let dbAvailable = true;
test.before(async () => {
  try {
    await pool.query('SELECT 1');
  } catch {
    dbAvailable = false;
  }
  TINY_PNG = await new Jimp(4, 4, 0xffffffff).getBufferAsync(Jimp.MIME_PNG);
});
test.after(async () => {
  await pool.end().catch(() => {});
  await fs.rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
});

test('replicate-vision, mocked at the Replicate HTTP boundary, produces real persisted surfaces/objects and mask files via the existing provider-agnostic pipeline', async (t) => {
  if (!dbAvailable) return t.skip('no database reachable in this environment');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;

  const project = await projectsModel.createProject({ clientName: 'replicate-contract-test', name: 'replicate-contract-test' });
  let assetId;
  try {
    const photo = await new Jimp(W, H, 0xffffffff).getBufferAsync(Jimp.MIME_PNG);
    const originalPath = await storage.saveBuffer('replicate-contract-test', 'original.png', photo);
    const asset = await assetsModel.createAsset({ projectId: project.id, originalPath });
    assetId = asset.id;

    const result = await houseUnderstanding.analyzeAsset(asset.id);

    assert.equal(result.ok, true, `analysis should succeed: ${result.failureReason}`);
    assert.equal(result.meta.provider, 'replicate-vision');
    assert.equal(result.house.present, true);

    // §19 — real resolved version hashes captured, not just the static
    // "replicate-grounding-dino-sam2-v1" label. Both are already cached from
    // the calls above, so no extra network round trip.
    assert.equal(result.meta.modelVersion, 'grounding-dino@dino-v1+sam-2@sam-v1');

    // The ambiguous "roof sky" detection must never have become a surface —
    // filterDetections' ambiguous-phrase rejection, exercised through the
    // real pipeline this time, not a unit test of the function in isolation.
    const surfaceKeys = result.surfaces.map((s) => s.class_key);
    assert.ok(surfaceKeys.includes('roof'));
    assert.ok(surfaceKeys.includes('front-wall'));

    // Persisted, not just returned in-memory — read back via the same
    // getAnalysis() call a real GET /ai/analysis request uses.
    const persisted = await houseUnderstanding.getAnalysis(asset.id);
    assert.equal(persisted.analyzed, true);
    assert.ok(persisted.surfaces.length > 0);
    assert.ok(persisted.objects.some((o) => o.class_key === 'tree'));

    // Every surface/object with a mask must have a real, readable file on disk
    // (not just a DB row claiming one exists).
    for (const s of persisted.surfaces) {
      if (!s.mask_path) continue;
      const buf = await storage.readFile(s.mask_path);
      assert.ok(buf.length > 0, `surface ${s.class_key}'s mask file should be readable`);
    }
    for (const o of persisted.objects) {
      if (!o.mask_path) continue;
      const buf = await storage.readFile(o.mask_path);
      assert.ok(buf.length > 0, `object ${o.class_key}'s mask file should be readable`);
    }

    // Windows are a non-paintable surface (mockProvider's convention,
    // replicated here) — never a removal candidate object.
    assert.ok(!persisted.objects.some((o) => o.class_key === 'window' || o.class_key === 'windows'));

    // The existing cleanup-mask connector (objectRemovalMask.service.js,
    // untouched by any of this work) must consume replicate-vision's
    // persisted output exactly like it already does for any other provider.
    const removalMask = await objectRemovalMask.buildDefaultRemovalMask(asset.id, W, H);
    assert.ok(removalMask, 'a default removal mask should be built from the detected tree object');
    assert.ok(removalMask.length > 0);

    // Sanity on the mocked call graph: version resolution cached per model
    // (not re-resolved on every one of the 3 segment calls).
    assert.equal(dinoVersionCalls, 1);
    assert.equal(samVersionCalls, 1);
    assert.equal(dinoCreateCalls, 1);
    assert.equal(samCreateCalls, 3); // roof, wall, tree — the only classes with surviving detections
  } finally {
    globalThis.fetch = originalFetch;
    if (assetId) await pool.query('DELETE FROM assets WHERE id = ?', [assetId]);
    await pool.query('DELETE FROM projects WHERE id = ?', [project.id]);
  }
});

test('a billing-style provider failure during detection is tagged stage:"detect", retryable:false, and marks the ai_jobs row failed (not silently swallowed)', async (t) => {
  if (!dbAvailable) return t.skip('no database reachable in this environment');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    const urlStr = String(url);
    if (method === 'GET' && urlStr === 'https://api.replicate.com/v1/models/adirik/grounding-dino') {
      return jsonResponse({ latest_version: { id: 'dino-v1' } });
    }
    if (method === 'POST' && urlStr === 'https://api.replicate.com/v1/predictions') {
      // Same shape real Replicate returned for the live 402 (see
      // AI_HOSTED_VALIDATION_REPORT.md) — a non-ok HTTP response, not a
      // network error, so httpClient.post's retry logic correctly treats it
      // as non-retriable (402 isn't in RETRYABLE_STATUSES).
      return { ok: false, status: 402, headers: { get: () => null }, text: async () => JSON.stringify({ detail: 'You have insufficient credit to run this model.' }) };
    }
    throw new Error('unexpected fetch call in failure-path test: ' + method + ' ' + urlStr);
  };

  const project = await projectsModel.createProject({ clientName: 'replicate-contract-fail-test', name: 'replicate-contract-fail-test' });
  let assetId;
  try {
    const photo = await new Jimp(W, H, 0xffffffff).getBufferAsync(Jimp.MIME_PNG);
    const originalPath = await storage.saveBuffer('replicate-contract-fail-test', 'original.png', photo);
    const asset = await assetsModel.createAsset({ projectId: project.id, originalPath });
    assetId = asset.id;

    const result = await houseUnderstanding.analyzeAsset(asset.id);

    assert.equal(result.ok, false);
    assert.match(result.failureReason, /402/);
    assert.equal(result.stage, 'detect');
    assert.equal(result.retryable, false);
    assert.equal(result.job.status, 'failed');

    // Persisted, not just returned in-memory.
    const jobRow = await require('../aiJobs.model').getJob(result.job.id);
    assert.equal(jobRow.status, 'failed');
    assert.match(jobRow.failure_reason, /402/);
  } finally {
    globalThis.fetch = originalFetch;
    if (assetId) await pool.query('DELETE FROM assets WHERE id = ?', [assetId]);
    await pool.query('DELETE FROM projects WHERE id = ?', [project.id]);
  }
});
