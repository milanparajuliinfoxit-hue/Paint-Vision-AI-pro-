/**
 * House-visualization orchestration (Gemini recolor) — also the
 * `visualize_paint` / `change_color` task types in the unified revision
 * timeline (see aiVisualizations.model.js's header).
 *
 * Gemini-first migration (governing brief Section 3/4/8/17/30): a prior
 * successful house-understanding (segmentation) run used to be a hard
 * prerequisite here — this function 409'd without one. That was exactly the
 * "mask-first" architecture the brief requires removing: real photos
 * produce fragmented, unreliable detected_surfaces (7 separate "window"
 * rows, bounding-box-like regions), and gating the whole product on that
 * quality was the core product problem. Catalog color selection is now
 * validated against `architecturalCategories.js`'s small fixed vocabulary
 * (Primary Wall, Trim, Door, ...) instead — a dealer can generate a
 * visualization the moment a photo is uploaded, zero segmentation required.
 *
 * The dealer-facing input is only ever { surfaceKey, paintId } pairs —
 * every surface key is checked against the fixed category list and every
 * paint id against the catalog before any prompt text is built, so this is
 * also the enforcement point for "the AI never invents a color" (Section 9)
 * and "never trust client-provided ids" (Section 24).
 */
const path = require('path');
const assetsModel = require('../assets.model');
const paintsModel = require('../paints.model');
const aiConfig = require('../../config/aiConfig');
const aiRegistry = require('./aiRegistry.service');
const aiJobsModel = require('../aiJobs.model');
const aiVisualizationsModel = require('../aiVisualizations.model');
const storage = require('../storage.service');
const visualizationPrompt = require('./visualizationPrompt.service');
const architecturalCategories = require('./architecturalCategories');
const { sanitizeUserIntent } = require('./textSanitize.util');

const VALID_TASK_TYPES = new Set(['visualize_paint', 'change_color']);

// Kicks off a new generation, or returns an existing 'ready' result if an
// identical request was already generated for this asset — avoids
// re-billing Gemini for a repeat request (governing brief Section 23).
async function requestVisualization(assetId, {
  surfaceColorPlan, schemeId, userIntent, taskType, parentRevisionId,
} = {}) {
  const asset = await assetsModel.getAsset(assetId);
  if (!asset) {
    const err = new Error('Asset not found');
    err.status = 404;
    throw err;
  }
  if (!aiConfig.isCapabilityEnabled('house-visualization')) {
    const err = new Error('AI visualization is disabled (AI_VISUALIZATION_ENABLED=false).');
    err.status = 403;
    throw err;
  }
  if (!Array.isArray(surfaceColorPlan) || surfaceColorPlan.length === 0) {
    const err = new Error('surfaceColorPlan must be a non-empty array of { surfaceKey, paintId }.');
    err.status = 400;
    throw err;
  }
  const resolvedTaskType = VALID_TASK_TYPES.has(taskType) ? taskType : 'visualize_paint';
  const cleanIntent = sanitizeUserIntent(userIntent);

  const resolvedPlan = [];
  const normalizedPlan = [];
  for (const entry of surfaceColorPlan) {
    if (!architecturalCategories.isValidCategory(entry?.surfaceKey)) {
      const err = new Error(`Unknown surface category "${entry?.surfaceKey}". Must be one of: ${architecturalCategories.CATEGORIES.map((c) => c.key).join(', ')}.`);
      err.status = 400;
      throw err;
    }
    const paint = await paintsModel.getById(entry.paintId);
    if (!paint || paint.is_deleted) {
      const err = new Error(`Unknown or deleted paint id ${entry.paintId}.`);
      err.status = 400;
      throw err;
    }
    resolvedPlan.push({
      surfaceKey: entry.surfaceKey,
      displayName: architecturalCategories.labelFor(entry.surfaceKey),
      paint: { id: paint.id, colorName: paint.color_name, hexValue: paint.hex_value },
    });
    normalizedPlan.push({ surfaceKey: entry.surfaceKey, paintId: paint.id });
  }

  // Resolve the source image to build on: an explicit parent revision (the
  // "change this specific result" flow) if given and valid, otherwise the
  // asset's own latest ready revision (any task type — a prepared/cleaned
  // photo chains forward automatically), otherwise the raw uploaded photo.
  const { sourcePath, resolvedParentId } = await resolveSource(asset, parentRevisionId);

  const existing = await findExisting(assetId, schemeId, normalizedPlan, cleanIntent, resolvedTaskType, resolvedParentId);
  if (existing) return existing;

  const provider = aiConfig.getProviderFor('house-visualization');
  const job = await aiJobsModel.createJob({ assetId, jobType: 'house-visualization', provider });
  const visualization = await aiVisualizationsModel.createPending({
    assetId, jobId: job.id, schemeId: schemeId || null, surfaceColorPlan: normalizedPlan,
    userIntent: cleanIntent || null, taskType: resolvedTaskType, parentRevisionId: resolvedParentId, sourcePath,
  });

  runVisualization({ asset, job, visualization, resolvedPlan, userIntent: cleanIntent, sourcePath }).catch(() => {});
  return visualization;
}

// A prior generated revision (isolation, an earlier recolor, ...) is a
// better "source" than always falling back to cleaned_path/original_path —
// this is what actually makes chained revisions (Prepared -> Painted ->
// re-colored) build on each other's real output instead of silently
// re-generating from the original photo every time.
async function resolveSource(asset, parentRevisionId) {
  if (parentRevisionId) {
    const parent = await aiVisualizationsModel.getVisualization(parentRevisionId);
    if (!parent || parent.asset_id !== asset.id) {
      const err = new Error(`Unknown revision id ${parentRevisionId} for this asset.`);
      err.status = 400;
      throw err;
    }
    if (parent.status !== 'ready') {
      const err = new Error(`Revision ${parentRevisionId} is not ready yet.`);
      err.status = 409;
      throw err;
    }
    return { sourcePath: parent.result_path, resolvedParentId: parent.id };
  }
  const latest = await aiVisualizationsModel.getLatestForAsset(asset.id);
  if (latest && latest.status === 'ready') {
    return { sourcePath: latest.result_path, resolvedParentId: latest.id };
  }
  return { sourcePath: asset.cleaned_path || asset.original_path, resolvedParentId: null };
}

async function runVisualization({ asset, job, visualization, resolvedPlan, userIntent, sourcePath }) {
  try {
    const buffer = await storage.readFile(sourcePath);
    const prompt = visualizationPrompt.buildRecolorPrompt(resolvedPlan, { userIntent });

    const result = await aiRegistry.run('house-visualization', { buffer, prompt, mimeType: 'image/jpeg' });

    if (!result.ok) {
      await aiJobsModel.markFailed(job.id, result.failureReason);
      await aiVisualizationsModel.markFailed(visualization.id, result.failureReason);
      return;
    }

    const { buffer: outBuffer, mimeType } = result.output;
    const ext = mimeType && mimeType.includes('png') ? 'png' : 'jpg';
    const resultPath = await storage.saveBuffer(
      path.join(asset.id, 'ai'),
      `visualization-${visualization.id}.${ext}`,
      outBuffer
    );

    await aiJobsModel.markSuccess(job.id, {
      confidence: result.confidence,
      processingTimeMs: result.processingTimeMs,
      modelVersion: result.modelVersion,
      outputJson: { resultPath },
    });
    await aiVisualizationsModel.markReady(visualization.id, { resultPath });
  } catch (err) {
    await aiJobsModel.markFailed(job.id, err.message).catch(() => {});
    await aiVisualizationsModel.markFailed(visualization.id, err.message).catch(() => {});
  }
}

async function getVisualization(assetId, id) {
  const v = await aiVisualizationsModel.getVisualization(id);
  if (!v || v.asset_id !== assetId) return null;
  return v;
}

async function listVisualizations(assetId) {
  return aiVisualizationsModel.listForAsset(assetId);
}

async function findExisting(assetId, schemeId, normalizedPlan, userIntent, taskType, parentRevisionId) {
  const list = await aiVisualizationsModel.listForAsset(assetId);
  const key = canonicalPlanKey(normalizedPlan);
  return list.find((v) =>
    v.status === 'ready' &&
    (v.scheme_id || null) === (schemeId || null) &&
    v.task_type === taskType &&
    (v.parent_revision_id || null) === (parentRevisionId || null) &&
    canonicalPlanKey(v.surfaceColorPlan) === key &&
    (v.user_intent || '') === (userIntent || '')
  ) || null;
}

function canonicalPlanKey(plan) {
  return JSON.stringify(
    [...(plan || [])]
      .sort((a, b) => a.surfaceKey.localeCompare(b.surfaceKey))
      .map((e) => `${e.surfaceKey}:${e.paintId}`)
  );
}

module.exports = { requestVisualization, getVisualization, listVisualizations };
