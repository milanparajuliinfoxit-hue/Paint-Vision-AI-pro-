const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const Jimp = require('jimp');

// CONTRACT TEST — fal.ai's HTTP boundary is fully mocked (global.fetch).
// Proves the wiring (fal-vision's per-class SAM-3 calls -> normalized
// output -> the existing provider-agnostic houseUnderstanding.service.js
// persistence path -> real detected_surfaces/detected_objects rows and mask
// files -> the existing cleanup-mask connector), exactly like
// houseUnderstanding.replicateVision.contract.test.js does for the other
// provider. NOT a claim about real segmentation quality — see that file's
// header for the same caveat, which applies identically here.
const scratchRoot = path.join(__dirname, '..', '__test_uploads_fal_contract__');
process.env.UPLOAD_ROOT = scratchRoot;
process.env.AI_ANALYSIS_ENABLED = 'true';
process.env.AI_ANALYSIS_PROVIDER = 'fal-vision';
process.env.FAL_API_KEY = 'test-fake-key';
process.env.FAL_SAM3_MODEL = 'fal-ai/sam-3/image';
process.env.AI_ANALYSIS_MAX_DIM = '640';

const pool = require('../../config/db');
const projectsModel = require('../projects.model');
const assetsModel = require('../assets.model');
const storage = require('../storage.service');
const houseUnderstanding = require('./houseUnderstanding.service');
const objectRemovalMask = require('./objectRemovalMask.service');

const W = 100, H = 80;
const SUBMIT_URL = 'https://queue.fal.run/fal-ai/sam-3/image';

let TINY_PNG;

function jsonResponse(obj) {
  const text = JSON.stringify(obj);
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => obj, text: async () => text, arrayBuffer: async () => Buffer.from(text, 'utf8') };
}

// Per class: roof/wall/tree get one surviving detection each (above their
// CLASS_THRESHOLDS); every other class gets a below-threshold or empty
// result, exercising the "no surviving detection -> source:'none'" path too.
const CLASS_RESULTS = {
  roof: { scores: [0.5], boxes: [[0.5, 0.1, 0.8, 0.2]] },
  wall: { scores: [0.6], boxes: [[0.5, 0.5, 0.8, 0.6]] },
  tree: { scores: [0.7], boxes: [[0.05, 0.8, 0.1, 0.3]] },
  window: { scores: [0.1], boxes: [[0.3, 0.3, 0.1, 0.1]] }, // below threshold (0.30)
  door: { scores: [], boxes: [] },
  car: { scores: [], boxes: [] },
  person: { scores: [], boxes: [] },
  fence: { scores: [], boxes: [] },
  sky: { scores: [], boxes: [] },
  ground: { scores: [], boxes: [] },
};

let maskUrlCalls = 0;
let submitCalls = 0;

async function fakeFetch(url, options = {}) {
  const method = options.method || 'GET';
  const urlStr = String(url);

  if (method === 'POST' && urlStr === SUBMIT_URL) {
    submitCalls++;
    const input = JSON.parse(options.body);
    const cls = input.prompt;
    const result = CLASS_RESULTS[cls];
    if (!result) throw new Error('unexpected prompt: ' + cls);
    const requestId = 'req-' + cls;
    return jsonResponse({
      request_id: requestId,
      status: 'COMPLETED',
      response_url: `https://queue.fal.run/fal-ai/sam-3/image/requests/${requestId}`,
    });
  }
  if (method === 'GET' && urlStr.startsWith('https://queue.fal.run/fal-ai/sam-3/image/requests/')) {
    const cls = urlStr.split('requests/req-')[1];
    const result = CLASS_RESULTS[cls];
    return jsonResponse({
      scores: result.scores,
      boxes: result.boxes,
      masks: result.scores.map((_, i) => ({ url: `https://fake.fal.media/mask-${cls}-${i}.png` })),
    });
  }
  if (method === 'GET' && urlStr.startsWith('https://fake.fal.media/mask-')) {
    maskUrlCalls++;
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => TINY_PNG, text: async () => '' };
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

test('fal-vision, mocked at the fal.ai HTTP boundary, produces real persisted surfaces/objects and mask files via the existing provider-agnostic pipeline', async (t) => {
  if (!dbAvailable) return t.skip('no database reachable in this environment');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;

  const project = await projectsModel.createProject({ clientName: 'fal-contract-test', name: 'fal-contract-test' });
  let assetId;
  try {
    const photo = await new Jimp(W, H, 0xffffffff).getBufferAsync(Jimp.MIME_PNG);
    const originalPath = await storage.saveBuffer('fal-contract-test', 'original.png', photo);
    const asset = await assetsModel.createAsset({ projectId: project.id, originalPath });
    assetId = asset.id;

    const result = await houseUnderstanding.analyzeAsset(asset.id);

    assert.equal(result.ok, true, `analysis should succeed: ${result.failureReason}`);
    assert.equal(result.meta.provider, 'fal-vision');
    assert.equal(result.house.present, true);
    assert.equal(result.meta.modelVersion, 'sam-3@fal-ai/sam-3/image');

    const surfaceKeys = result.surfaces.map((s) => s.class_key);
    assert.ok(surfaceKeys.includes('roof'));
    assert.ok(surfaceKeys.includes('front-wall'));
    // window scored below CLASS_THRESHOLDS.window (0.30) — must not appear.
    assert.ok(!surfaceKeys.includes('windows'));

    const persisted = await houseUnderstanding.getAnalysis(asset.id);
    assert.equal(persisted.analyzed, true);
    assert.ok(persisted.objects.some((o) => o.class_key === 'tree'));

    for (const s of persisted.surfaces) {
      if (!s.mask_path) continue;
      const buf = await storage.readFile(s.mask_path);
      assert.ok(buf.length > 0, `surface ${s.class_key}'s mask file should be readable`);
    }

    // One submit call per class in PROMPT_CLASSES (10), one mask-URL
    // download per class that had a surviving detection (roof/wall/tree = 3).
    assert.equal(submitCalls, 10);
    assert.equal(maskUrlCalls, 3);

    // The existing cleanup-mask connector must consume fal-vision's
    // persisted output exactly like it already does for any other provider.
    const removalMask = await objectRemovalMask.buildDefaultRemovalMask(asset.id, W, H);
    assert.ok(removalMask, 'a default removal mask should be built from the detected tree object');
  } finally {
    globalThis.fetch = originalFetch;
    if (assetId) await pool.query('DELETE FROM assets WHERE id = ?', [assetId]);
    await pool.query('DELETE FROM projects WHERE id = ?', [project.id]);
  }
});
