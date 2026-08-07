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

async function analyzeAsset(req, res, next) {
  try {
    res.json(await houseUnderstanding.analyzeAsset(req.params.assetId));
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
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  analyzeAsset, getAnalysis, generateRecommendations, listRecommendations, getMeta,
  processAsset, getPipelineStatus,
};
