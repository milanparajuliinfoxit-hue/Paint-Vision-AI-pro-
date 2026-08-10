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
const { withLock } = require('./inFlightLock.service');

// job_type recorded for this capability's ai_jobs audit rows — also what the
// pipeline orchestrator (aiPipeline.service.js) polls for to know a scheme
// batch has actually been generated for the asset's current analysis.
const JOB_TYPE = 'paint-recommendation';

// Locked per asset (not per asset+count — the thing being protected is the
// clearForAsset-then-recreate loop below, which is asset-scoped; two
// concurrent calls with different `count` values should still serialize,
// not run in parallel and race each other's delete/insert). A second
// concurrent caller awaits and gets the first caller's result rather than
// running the provider and the clear+recreate again.
function generateRecommendations(assetId, options = {}) {
  return withLock(`recommend:${assetId}`, () => runGenerateRecommendations(assetId, options));
}

async function runGenerateRecommendations(assetId, { count } = {}) {
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

  // Versioned audit row, same pattern as house-understanding — this is also
  // what lets the pipeline orchestrator know a scheme batch actually ran
  // (previously recommendation runs left no ai_jobs trail at all).
  const job = await aiJobsModel.createJob({
    assetId: asset.id,
    jobType: JOB_TYPE,
    provider: aiConfig.getProviderFor('paint-recommendation'),
  });

  // Phase 5 gate: a surface that failed quality validation (see
  // surfaceQuality.service.js) still shows up in the AI Understand tab for
  // the dealer to inspect/use manually, but never feeds automatic scheme
  // generation — a bad mask shouldn't silently become part of a "confident"
  // AI recommendation. Surfaces from analyses run before this existed have
  // no `quality` field and are treated as eligible (no silent behavior
  // change for already-persisted analyses).
  const eligibleSurfaces = analysis.surfaces.filter((s) => s.properties?.quality?.tier !== 'low');

  const result = await aiRegistry.run('paint-recommendation', {
    analysis: {
      house: analysis.house,
      context: analysis.context,
      surfaces: eligibleSurfaces.map((s) => ({
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
    await aiJobsModel.markFailed(job.id, result.failureReason);
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
      rationale: { templateId: scheme.id, provider: result.provider, modelVersion: result.modelVersion, score: scheme.score ?? null },
      schemeJson: scheme.surfaces,
    });
    schemes.push(resolveScheme(row, paints));
  }

  await aiJobsModel.markSuccess(job.id, {
    confidence: result.confidence,
    processingTimeMs: result.processingTimeMs,
    modelVersion: result.modelVersion,
    outputJson: { analysisId: analysis.job.id, count: schemes.length },
  });

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
