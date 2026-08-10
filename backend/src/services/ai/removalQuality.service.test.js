const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Jimp = require('jimp');

process.env.UPLOAD_ROOT = path.join(__dirname, '__test_uploads_removal_quality__');
const aiJobsModel = require('../aiJobs.model');
const storage = require('../storage.service');
const { checkHouseDamage } = require('./removalQuality.service');

async function pngBuffer(width, height, rgba) {
  const img = new Jimp(width, height, rgba);
  return img.getBufferAsync(Jimp.MIME_PNG);
}

test('no analysis at all -> unverifiable, never blocks cleanup', async () => {
  const orig = aiJobsModel.getLatestAnalysis;
  aiJobsModel.getLatestAnalysis = async () => null;
  try {
    const buf = await pngBuffer(4, 4, 0xffffffff);
    const result = await checkHouseDamage('asset-1', buf, buf);
    assert.equal(result.damaged, false);
    assert.equal(result.unverifiable, true);
  } finally {
    aiJobsModel.getLatestAnalysis = orig;
  }
});

test('cleaned image of a different size -> unverifiable, never blocks cleanup', async () => {
  const origGet = aiJobsModel.getLatestAnalysis;
  aiJobsModel.getLatestAnalysis = async () => ({
    surfaces: [{ paintable: true, mask_path: 'does-not-matter.png' }],
  });
  try {
    const original = await pngBuffer(10, 10, 0xffffffff);
    const cleaned = await pngBuffer(8, 8, 0xffffffff);
    const result = await checkHouseDamage('asset-1', original, cleaned);
    assert.equal(result.damaged, false);
    assert.equal(result.unverifiable, true);
  } finally {
    aiJobsModel.getLatestAnalysis = origGet;
  }
});

test('identical images -> not damaged', async () => {
  const maskPath = 'asset-2/ai/front-wall.png';
  await storage.saveBuffer('asset-2/ai', 'front-wall.png', await pngBuffer(4, 4, 0xffffffff));

  const origGet = aiJobsModel.getLatestAnalysis;
  aiJobsModel.getLatestAnalysis = async () => ({
    surfaces: [{ paintable: true, mask_path: maskPath }],
  });
  try {
    const buf = await pngBuffer(4, 4, 0x808080ff);
    const result = await checkHouseDamage('asset-2', buf, buf);
    assert.equal(result.damaged, false);
    assert.equal(result.changedFraction, 0);
  } finally {
    aiJobsModel.getLatestAnalysis = origGet;
  }
});

test('the entire protected surface changing color -> damaged', async () => {
  const maskPath = 'asset-3/ai/front-wall.png';
  // Fully-opaque white mask = the whole 4x4 image is "protected."
  await storage.saveBuffer('asset-3/ai', 'front-wall.png', await pngBuffer(4, 4, 0xffffffff));

  const origGet = aiJobsModel.getLatestAnalysis;
  aiJobsModel.getLatestAnalysis = async () => ({
    surfaces: [{ paintable: true, mask_path: maskPath }],
  });
  try {
    const original = await pngBuffer(4, 4, 0x202020ff); // near-black
    const cleaned = await pngBuffer(4, 4, 0xf0f0f0ff); // near-white — every protected pixel changed drastically
    const result = await checkHouseDamage('asset-3', original, cleaned);
    assert.equal(result.damaged, true);
    assert.ok(result.changedFraction > 0.9, `expected most pixels flagged changed, got ${result.changedFraction}`);
  } finally {
    aiJobsModel.getLatestAnalysis = origGet;
  }
});
