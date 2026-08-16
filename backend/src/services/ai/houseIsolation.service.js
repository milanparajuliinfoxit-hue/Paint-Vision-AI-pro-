/**
 * House preparation ("prepare_house") and targeted object removal
 * ("remove_objects") — the two Gemini cleanup task types in the unified
 * revision timeline (aiVisualizations.model.js). Both write a real
 * `ai_visualizations` row chained via parent_revision_id, exactly like
 * visualization.service.js's recolor tasks — this is what makes
 * Original -> Prepared -> Painted a single traceable lineage instead of
 * three disconnected features (governing brief Section 13).
 *
 * Deliberately separate from the existing ClipDrop/HF `/clean` endpoint
 * (assets.controller.js:requestCleanup) — that feature is a mask-guided
 * inpainting removal tool the dealer drives by hand or via detected-object
 * masks, and stays untouched (brief Section 19: "keep it isolated ... do
 * not make it part of the core Gemini pipeline"). These are whole-photo,
 * semantic-instruction Gemini edits — `prepare_house` uses a fixed
 * comprehensive prompt, `remove_objects` uses a dealer-specified one
 * (houseIsolationPrompt.service.js).
 *
 * Also still updates `assets.cleaned_path` on success — the existing
 * Original/Cleaned/Painted top-nav vocabulary treats this the same way
 * regardless of which tool (Gemini or ClipDrop) produced the current
 * cleaned image.
 */
const assetsModel = require('../assets.model');
const aiConfig = require('../../config/aiConfig');
const aiRegistry = require('./aiRegistry.service');
const aiJobsModel = require('../aiJobs.model');
const aiVisualizationsModel = require('../aiVisualizations.model');
const storage = require('../storage.service');
const isolationPrompt = require('./houseIsolationPrompt.service');
const { sanitizeUserIntent } = require('./textSanitize.util');

const CAPABILITY = 'house-isolation';

async function requestIsolation(assetId) {
  return runTask(assetId, {
    taskType: 'prepare_house',
    buildPrompt: () => isolationPrompt.buildIsolationPrompt(),
    userIntent: null,
  });
}

async function requestObjectRemoval(assetId, { userIntent } = {}) {
  const cleanIntent = sanitizeUserIntent(userIntent);
  if (!cleanIntent) {
    const err = new Error('Describe what to remove (e.g. "remove the people and bicycles").');
    err.status = 400;
    throw err;
  }
  return runTask(assetId, {
    taskType: 'remove_objects',
    buildPrompt: () => isolationPrompt.buildObjectRemovalPrompt(cleanIntent),
    userIntent: cleanIntent,
  });
}

async function runTask(assetId, { taskType, buildPrompt, userIntent }) {
  const asset = await assetsModel.getAsset(assetId);
  if (!asset) {
    const err = new Error('Asset not found');
    err.status = 404;
    throw err;
  }
  if (!aiConfig.isCapabilityEnabled(CAPABILITY)) {
    const err = new Error('AI house preparation is disabled (AI_ISOLATION_ENABLED=false).');
    err.status = 403;
    throw err;
  }
  if (!aiConfig.getProviderFor(CAPABILITY)) {
    const err = new Error('No AI isolation provider configured (set AI_ISOLATION_PROVIDER).');
    err.status = 403;
    throw err;
  }

  const latest = await aiVisualizationsModel.getLatestForAsset(assetId);
  const sourcePath = (latest && latest.status === 'ready') ? latest.result_path : asset.original_path;
  const parentRevisionId = (latest && latest.status === 'ready') ? latest.id : null;

  const provider = aiConfig.getProviderFor(CAPABILITY);
  const job = await aiJobsModel.createJob({ assetId, jobType: CAPABILITY, provider });
  const revision = await aiVisualizationsModel.createPending({
    assetId, jobId: job.id, taskType, parentRevisionId, sourcePath,
    surfaceColorPlan: [], userIntent,
  });

  run({ asset, job, revision, buildPrompt, sourcePath }).catch(() => {});
  return revision;
}

async function run({ asset, job, revision, buildPrompt, sourcePath }) {
  try {
    const buffer = await storage.readFile(sourcePath);
    const prompt = buildPrompt();

    const result = await aiRegistry.run(CAPABILITY, { buffer, prompt, mimeType: 'image/jpeg' });

    if (!result.ok) {
      await aiJobsModel.markFailed(job.id, result.failureReason);
      await aiVisualizationsModel.markFailed(revision.id, result.failureReason);
      return;
    }

    const { buffer: outBuffer, mimeType } = result.output;
    const ext = mimeType && mimeType.includes('png') ? 'png' : 'jpg';
    const resultPath = await storage.saveBuffer(asset.id, `revision-${revision.id}.${ext}`, outBuffer);

    await assetsModel.updateAssetStatus(asset.id, { status: 'cleaned', cleanedPath: resultPath });
    await aiJobsModel.markSuccess(job.id, {
      confidence: result.confidence,
      processingTimeMs: result.processingTimeMs,
      modelVersion: result.modelVersion,
      outputJson: { resultPath },
    });
    await aiVisualizationsModel.markReady(revision.id, { resultPath });
  } catch (err) {
    await aiJobsModel.markFailed(job.id, err.message).catch(() => {});
    await aiVisualizationsModel.markFailed(revision.id, err.message).catch(() => {});
  }
}

module.exports = { requestIsolation, requestObjectRemoval };
