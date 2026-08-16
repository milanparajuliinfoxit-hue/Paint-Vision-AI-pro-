/**
 * Public AI API controller.
 *
 * Exposes the AI capabilities of the platform: asset analysis
 * (house-understanding), persisted recommendations, and a meta endpoint the UI
 * uses to know which capabilities/providers are live (feature-flag aware).
 */
const aiConfig = require('../config/aiConfig');
const aiRegistry = require('../services/ai/aiRegistry.service');
const houseUnderstanding = require('../services/ai/houseUnderstanding.service');
const paintRecommendation = require('../services/ai/paintRecommendation.service');
const aiPipeline = require('../services/ai/aiPipeline.service');
const visualization = require('../services/ai/visualization.service');
const houseIsolation = require('../services/ai/houseIsolation.service');
const architecturalCategories = require('../services/ai/architecturalCategories');

const wallSegmentation = require('../services/ai/wallSegmentation.service');

async function analyzeAsset(req, res, next) {
  try {
    res.json(await houseUnderstanding.analyzeAsset(req.params.assetId));
  } catch (err) {
    next(err);
  }
}

async function segmentWall(req, res, next) {
  try {
    const { x, y, positivePoints, negativePoints, mode, tolerance } = req.body || {};
    if (x === undefined || y === undefined) {
      return res.status(400).json({ error: 'Click coordinates (x, y) are required.' });
    }
    const result = await wallSegmentation.segmentWallAtPoint({
      assetId: req.params.assetId,
      x: Number(x),
      y: Number(y),
      positivePoints: Array.isArray(positivePoints) ? positivePoints : [],
      negativePoints: Array.isArray(negativePoints) ? negativePoints : [],
      mode: mode || 'new',
      tolerance: tolerance !== undefined ? Number(tolerance) : undefined,
    });

    // Convert Uint8Array alpha mask to base64 or array format for JSON delivery
    const maskBase64 = Buffer.from(result.alpha).toString('base64');

    res.json({
      ok: result.ok,
      width: result.width,
      height: result.height,
      alphaBase64: maskBase64,
      pixelCount: result.pixelCount,
      confidence: result.confidence,
      boundingBox: result.boundingBox,
      wallPlaneId: result.wallPlaneId,
      processingTimeMs: result.processingTimeMs,
      provider: result.provider,
    });
  } catch (err) {
    next(err);
  }
}

async function getAnalysis(req, res, next) {
  try {
    res.json(await houseUnderstanding.getAnalysis(req.params.assetId));
  } catch (err) {
    next(err);
  }
}

async function generateRecommendations(req, res, next) {
  try {
    const count = req.body && req.body.count ? Number(req.body.count) : undefined;
    res.json(await paintRecommendation.generateRecommendations(req.params.assetId, { count }));
  } catch (err) {
    next(err);
  }
}

async function listRecommendations(req, res, next) {
  try {
    res.json(await paintRecommendation.listRecommendations(req.params.assetId));
  } catch (err) {
    next(err);
  }
}

// Starts (or reports the status of) the autonomous pipeline for an asset —
// the frontend calls this right after upload so analysis + recommendations
// run without the dealer clicking anything. Idempotent unless {force:true}.
async function processAsset(req, res, next) {
  try {
    res.json(await aiPipeline.startPipeline(req.params.assetId, { force: !!(req.body && req.body.force) }));
  } catch (err) {
    next(err);
  }
}

async function getPipelineStatus(req, res, next) {
  try {
    res.json(await aiPipeline.getStatus(req.params.assetId));
  } catch (err) {
    next(err);
  }
}

async function getMeta(req, res, next) {
  try {
    res.json({
      ai: {
        analysis: {
          enabled: aiConfig.isCapabilityEnabled('house-understanding'),
          provider: aiConfig.getProviderFor('house-understanding'),
          modelVersion: aiRegistry.getProviderVersion('house-understanding'),
        },
        recommendation: {
          enabled: aiConfig.isCapabilityEnabled('paint-recommendation'),
          provider: aiConfig.getProviderFor('paint-recommendation'),
          modelVersion: aiRegistry.getProviderVersion('paint-recommendation'),
          count: aiConfig.getRecommendationCount(),
        },
        visualization: {
          enabled: aiConfig.isCapabilityEnabled('house-visualization'),
          provider: aiConfig.getProviderFor('house-visualization'),
          modelVersion: aiRegistry.getProviderVersion('house-visualization'),
        },
        isolation: {
          enabled: aiConfig.isCapabilityEnabled('house-isolation'),
          provider: aiConfig.getProviderFor('house-isolation'),
          modelVersion: aiRegistry.getProviderVersion('house-isolation'),
        },
      },
      // Fixed semantic paint-target vocabulary (Gemini-first migration —
      // color selection no longer depends on a prior segmentation run).
      architecturalCategories: architecturalCategories.CATEGORIES,
    });
  } catch (err) {
    next(err);
  }
}

// Handles visualize_paint (default) and change_color (explicit
// parentRevisionId — "regenerate this specific result with an updated
// color plan") task types; both are the same underlying operation, just
// recorded distinctly in the revision timeline.
async function requestVisualization(req, res, next) {
  try {
    const { surfaceColorPlan, schemeId, userIntent, taskType, parentRevisionId } = req.body || {};
    const result = await visualization.requestVisualization(req.params.assetId, {
      surfaceColorPlan, schemeId, userIntent, taskType, parentRevisionId,
    });
    res.status(202).json(result);
  } catch (err) {
    next(err);
  }
}

async function requestIsolation(req, res, next) {
  try {
    const revision = await houseIsolation.requestIsolation(req.params.assetId);
    res.status(202).json(revision);
  } catch (err) {
    next(err);
  }
}

async function requestObjectRemoval(req, res, next) {
  try {
    const { userIntent } = req.body || {};
    const revision = await houseIsolation.requestObjectRemoval(req.params.assetId, { userIntent });
    res.status(202).json(revision);
  } catch (err) {
    next(err);
  }
}

async function getVisualization(req, res, next) {
  try {
    const result = await visualization.getVisualization(req.params.assetId, Number(req.params.visualizationId));
    if (!result) return res.status(404).json({ error: 'Visualization not found' });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

// Doubles as the unified revision-history list — every task type
// (prepare_house/remove_objects/visualize_paint/change_color) lives in the
// same table, so this one endpoint backs the whole "Original -> Prepared ->
// Painted" timeline the frontend renders, not a per-task endpoint each.
async function listVisualizations(req, res, next) {
  try {
    res.json(await visualization.listVisualizations(req.params.assetId));
  } catch (err) {
    next(err);
  }
}

module.exports = {
  analyzeAsset, getAnalysis, generateRecommendations, listRecommendations, getMeta,
  processAsset, getPipelineStatus, segmentWall,
  requestVisualization, getVisualization, listVisualizations,
  requestIsolation, requestObjectRemoval,
};
