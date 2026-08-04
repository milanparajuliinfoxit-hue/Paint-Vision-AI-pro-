/**
 * Paint-recommendation orchestration.
 *
 * Generates 5–10 paint schemes for an analyzed asset. Schemes are built by the
 * configured 'paint-recommendation' provider and reference paint IDs that exist
 * in the paints catalog only — the AI never invents a color or a paint.
 */
const aiConfig = require('../../config/aiConfig');
const aiRegistry = require('./aiRegistry.service');
const assetsModel = require('../assets.model');
const paintsModel = require('../paints.model');
const aiJobsModel = require('../aiJobs.model');
const recommendationsModel = require('../paintRecommendation.model');

async function generateRecommendations(assetId, { count } = {}) {
  const asset = await assetsModel.getAsset(assetId);
  if (!asset) {
    const err = new Error('Asset not found');
    err.status = 404;
    throw err;
  }
  if (!aiConfig.isCapabilityEnabled('paint-recommendation')) {
    const err = new Error('AI recommendations are disabled (AI_RECOMMENDATION_ENABLED=false).');
    err.status = 403;
    throw err;
  }

  const analysis = await aiJobsModel.getLatestAnalysis(assetId);
  if (!analysis) {
    const err = new Error('Analyze the asset first — recommendations need the house understanding.');
    err.status = 409;
    throw err;
  }

  const paints = (await paintsModel.list({ page: 1, pageSize: 100000 })).rows;
  if (!paints.length) {
    const err = new Error('The paint catalog is empty — add paints before generating recommendations.');
    err.status = 409;
    throw err;
  }

  const result = await aiRegistry.run('paint-recommendation', {
    analysis: {
      house: analysis.house,
      context: analysis.context,
      surfaces: analysis.surfaces.map((s) => ({
        className: s.class_key,
        role: s.properties && s.properties.role ? s.properties.role : null,
        paintable: s.paintable,
      })),
    },
    paints,
    count: count || aiConfig.getRecommendationCount(),
    productLines: aiConfig.getRecommendationProductLines(),
  });

  if (!result.ok) {
    const err = new Error(result.failureReason);
    err.status = 502;
    throw err;
  }

  await recommendationsModel.clearForAsset(asset.id);
  const schemes = [];
  for (const scheme of result.output.schemes) {
    const row = await recommendationsModel.createScheme({
      projectId: asset.project_id,
      assetId: asset.id,
      schemeName: scheme.name,
      tagline: scheme.tagline,
      rationale: { templateId: scheme.id, provider: result.provider, modelVersion: result.modelVersion },
      schemeJson: scheme.surfaces,
    });
    schemes.push(resolveScheme(row, paints));
  }

  return {
    schemes,
    meta: {
      provider: result.provider,
      modelVersion: result.modelVersion,
      confidence: result.confidence,
      processingTimeMs: result.processingTimeMs,
      count: schemes.length,
    },
  };
}

async function listRecommendations(assetId) {
  const paints = (await paintsModel.list({ page: 1, pageSize: 100000 })).rows;
  const rows = await recommendationsModel.listForAsset(assetId);
  return rows.map((row) => resolveScheme(row, paints));
}

// Attaches the full paint object so the UI never has to re-join catalog data.
function resolveScheme(row, paints) {
  const byId = new Map(paints.map((p) => [p.id, p]));
  return {
    id: row.id,
    name: row.scheme_name,
    tagline: row.tagline,
    rationale: row.rationale,
    createdAt: row.created_at,
    surfaces: (row.schemeJson || []).map((s) => ({
      role: s.role,
      surfaceClass: s.surfaceClass,
      paintId: s.paintId,
      paint: byId.get(s.paintId) || null,
    })),
  };
}

module.exports = { generateRecommendations, listRecommendations };
