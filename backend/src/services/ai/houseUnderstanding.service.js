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
const surfaceQuality = require('./surfaceQuality.service');
const { withLock } = require('./inFlightLock.service');

// Public entry point — locked per asset so two concurrent callers (a
// double-clicked "Analyze" button, the autonomous pipeline racing a manual
// click, a retried request) can't both run the provider and both write a
// job row at once. The second caller awaits and gets the same result as the
// first, rather than kicking off a redundant (and, for a real provider,
// billed) analysis.
function analyzeAsset(assetId) {
  return withLock(`understanding:${assetId}`, () => runAnalysis(assetId));
}

async function runAnalysis(assetId) {
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

  const buffer = await storage.readFile(asset.original_path);
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

  // Surface-quality validation (Phase 5): score every surface on geometric
  // plausibility, house containment, and non-paintable-object overlap, not
  // just the provider's own confidence number. Stored in the existing
  // `properties` JSON column — no schema change — and read back by
  // paintRecommendation.service.js to keep low-quality surfaces out of
  // automatic scheme generation while still showing them in the AI
  // Understand tab.
  //
  // The whole persistence block is wrapped because a real (if narrow) race
  // exists: the asset can be deleted while a real provider's inference is
  // still in flight (several seconds, unlike the mock's near-instant
  // response) — every insert below has a foreign key back to `job.id`,
  // which cascade-deletes with the asset, so a delete mid-analysis turns
  // the next insert into a raw MySQL FK error. The autonomous pipeline
  // already absorbs that (aiPipeline.service.js's runPipeline .catch()),
  // but the manual `POST /ai/analyze` endpoint would otherwise let it
  // propagate as an unformatted database error straight into the API
  // response — exactly what Rule "never expose SQL errors" prohibits.
  try {
    const objectMasks = (out.objects || []).map((o) => o.mask).filter(Boolean);
    const surfaces = [];
    for (const s of out.surfaces || []) {
      const maskPath = s.mask ? await saveMask(asset.id, `${s.key}.png`, s.mask) : null;
      const quality = surfaceQuality.scoreSurface(s, {
        houseBbox: out.house?.bbox,
        width: out.scale?.width,
        height: out.scale?.height,
        objectMasks,
      });
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
        properties: { ...(s.properties || {}), quality },
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
  } catch (err) {
    if (err.code === 'ER_NO_REFERENCED_ROW_2' || err.code === 'ER_NO_REFERENCED_ROW') {
      const cleanErr = new Error('This photo was deleted while it was being analyzed.');
      cleanErr.status = 409;
      throw cleanErr;
    }
    throw err;
  }
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
  return await storage.saveBuffer(path.join(assetId, 'ai'), filename, png);
}

module.exports = { analyzeAsset, getAnalysis };
