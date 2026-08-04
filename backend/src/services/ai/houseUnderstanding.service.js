/**
 * House-understanding orchestration.
 *
 * Runs the configured 'house-understanding' provider over an asset's photo,
 * persists the versioned job + structured surfaces/objects, saves the alpha
 * masks to disk (same storage pattern as layer masks), and returns a clean
 * response. No code here knows which provider is behind the registry — the
 * whole module is provider-independent by construction.
 */
const path = require('path');
const Jimp = require('jimp');
const aiConfig = require('../../config/aiConfig');
const aiRegistry = require('./aiRegistry.service');
const assetsModel = require('../assets.model');
const storage = require('../storage.service');
const aiJobsModel = require('../aiJobs.model');

async function analyzeAsset(assetId) {
  const asset = await assetsModel.getAsset(assetId);
  if (!asset) {
    const err = new Error('Asset not found');
    err.status = 404;
    throw err;
  }
  if (!aiConfig.isCapabilityEnabled('house-understanding')) {
    const err = new Error('AI analysis is disabled (AI_ANALYSIS_ENABLED=false).');
    err.status = 403;
    throw err;
  }

  const buffer = storage.readFile(asset.original_path);
  const job = await aiJobsModel.createJob({
    assetId: asset.id,
    jobType: 'house-understanding',
    provider: aiConfig.getProviderFor('house-understanding'),
  });

  const result = await aiRegistry.run('house-understanding', { buffer });

  if (!result.ok) {
    await aiJobsModel.markFailed(job.id, result.failureReason);
    return {
      ok: false,
      failureReason: result.failureReason,
      job: await aiJobsModel.getJob(job.id),
    };
  }

  const out = result.output;

  const surfaces = [];
  for (const s of out.surfaces || []) {
    const maskPath = s.mask ? await saveMask(asset.id, `${s.key}.png`, s.mask) : null;
    surfaces.push(await aiJobsModel.createSurface({
      analysisId: job.id,
      assetId: asset.id,
      classKey: s.key,
      displayName: s.displayName || s.className || s.key,
      paintable: !!s.paintable,
      confidence: s.confidence ?? null,
      maskPath,
      geometry: s.geometry ?? null,
      averageColor: s.averageColor ?? null,
      properties: s.properties ?? null,
    }));
  }

  const objects = [];
  for (const o of out.objects || []) {
    const maskPath = o.mask ? await saveMask(asset.id, `${o.key}.png`, o.mask) : null;
    objects.push(await aiJobsModel.createObject({
      analysisId: job.id,
      assetId: asset.id,
      classKey: o.className || o.key,
      displayName: o.displayName || o.className || o.key,
      confidence: o.confidence ?? null,
      maskPath,
      geometry: o.geometry ?? null,
    }));
  }

  const updatedJob = await aiJobsModel.markSuccess(job.id, {
    confidence: result.confidence,
    processingTimeMs: result.processingTimeMs,
    modelVersion: result.modelVersion,
    outputJson: { house: out.house, context: out.context, scale: out.scale },
  });

  return {
    ok: true,
    job: updatedJob,
    house: out.house,
    context: out.context,
    scale: out.scale,
    surfaces,
    objects,
    meta: {
      provider: result.provider,
      modelVersion: result.modelVersion,
      confidence: result.confidence,
      processingTimeMs: result.processingTimeMs,
    },
  };
}

// Latest successful analysis for an asset (empty structured shape when none).
async function getAnalysis(assetId) {
  const analysis = await aiJobsModel.getLatestAnalysis(assetId);
  if (!analysis) {
    return { analyzed: false, job: null, house: null, context: null, surfaces: [], objects: [] };
  }
  return { ...analysis, analyzed: true };
}

// Converts a { width, height, alpha } provider mask into an alpha PNG on disk.
async function saveMask(assetId, filename, mask) {
  const img = new Jimp(mask.width, mask.height, 0x00000000);
  img.scan(0, 0, mask.width, mask.height, (x, y, idx) => {
    img.bitmap.data[idx + 3] = mask.alpha[y * mask.width + x];
  });
  const png = await img.getBufferAsync(Jimp.MIME_PNG);
  return storage.saveBuffer(path.join(assetId, 'ai'), filename, png);
}

module.exports = { analyzeAsset, getAnalysis };
