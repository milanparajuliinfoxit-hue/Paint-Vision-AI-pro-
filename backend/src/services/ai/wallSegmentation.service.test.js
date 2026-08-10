const test = require('node:test');
const assert = require('node:assert/strict');
const wallSegmentation = require('./wallSegmentation.service');
const assetsModel = require('../assets.model');

test('segmentWallAtPoint generates alpha mask and bounding box for a point prompt', async () => {
  wallSegmentation.clearAssetCache();

  // Mock getAssetById to return standard dimensions
  const origGetAssetById = assetsModel.getAssetById;
  assetsModel.getAssetById = async (id) => ({
    id,
    original_path: 'uploads/mock.png',
    width: 100,
    height: 100,
  });

  try {
    const res = await wallSegmentation.segmentWallAtPoint({
      assetId: 'test-asset-1',
      x: 50,
      y: 50,
      tolerance: 40,
    });

    assert.equal(res.ok, true);
    assert.equal(res.width, 100);
    assert.equal(res.height, 100);
    assert.ok(res.alpha instanceof Uint8Array);
    assert.equal(res.alpha.length, 10000);
    assert.ok(res.pixelCount > 0);
    assert.ok(res.boundingBox !== null);
    assert.ok(typeof res.processingTimeMs === 'number');
    assert.ok(res.wallPlaneId.startsWith('wall_plane_'));
  } finally {
    assetsModel.getAssetById = origGetAssetById;
  }
});

test('segmentWallAtPoint handles positive and negative point refinements', async () => {
  wallSegmentation.clearAssetCache();

  const origGetAssetById = assetsModel.getAssetById;
  assetsModel.getAssetById = async (id) => ({
    id,
    original_path: 'uploads/mock.png',
    width: 50,
    height: 50,
  });

  try {
    const resWithNeg = await wallSegmentation.segmentWallAtPoint({
      assetId: 'test-asset-2',
      x: 25,
      y: 25,
      positivePoints: [{ x: 10, y: 10 }],
      negativePoints: [{ x: 25, y: 25 }],
    });

    assert.equal(resWithNeg.ok, true);
    // Negative point at (25, 25) should clear alpha to 0 in that center radius
    const centerIdx = 25 * 50 + 25;
    assert.equal(resWithNeg.alpha[centerIdx], 0);
  } finally {
    assetsModel.getAssetById = origGetAssetById;
  }
});
