/**
 * Autonomous AI pipeline orchestration (Phase 2).
 *
 * Chains house-understanding -> paint-recommendation automatically so a
 * dealer never has to click "Analyze" / "Generate" as a manual prerequisite
 * before schemes are available. Object removal (`/clean`) deliberately stays
 * a separate, manual, optional action — product decision, not a pipeline
 * stage: it's a paid external inpainting call and most photos have nothing
 * to remove, so auto-running it on every upload would be wasteful and
 * surprising, not helpful.
 *
 * No new job/status table. `ai_jobs` already has everything a pipeline
 * status needs (status, timing, failure_reason, job_type) — status here is
 * *derived* from the latest job per type, never stored separately, so there
 * is exactly one source of truth for "did this stage actually run" (the
 * same table the AI Understand / AI Schemes tabs already read).
 */
const aiJobsModel = require('../aiJobs.model');
const houseUnderstanding = require('./houseUnderstanding.service');
const paintRecommendation = require('./paintRecommendation.service');

// Guards against duplicate concurrent runs for the same asset within this
// process (e.g. a double-fired upload handler). Not cross-process — this
// app runs as a single Node process, matching every other in-memory guard
// already in the codebase (mask-write queue, preview cache).
const inFlight = new Set();

// Starts the pipeline for an asset. Idempotent by default: if the asset is
// already mid-pipeline or already has a ready result, returns the current
// status instead of re-running (so re-triggering on page reload, or a
// second upload-handler invocation, never re-burns provider calls). Pass
// force:true to re-run regardless (the "Try Again" affordance on a failed
// pipeline, or an explicit re-analyze).
async function startPipeline(assetId, { force = false } = {}) {
  if (inFlight.has(assetId)) return getStatus(assetId);

  // Claim the slot *before* the first await, not after — the previous
  // version checked-then-awaited-then-claimed, leaving a window where two
  // near-simultaneous calls (e.g. a double-clicked "Try again") could both
  // pass the `inFlight.has` check and both end up running the pipeline for
  // the same asset. Node is single-threaded, so a synchronous check+claim
  // with no await between them can't be interleaved by another call.
  inFlight.add(assetId);
  let current;
  try {
    current = await getStatus(assetId);
  } catch (err) {
    inFlight.delete(assetId);
    throw err;
  }

  if (!force && (current.stage === 'understanding' || current.stage === 'schemes' || current.stage === 'ready')) {
    inFlight.delete(assetId); // nothing to run — release the claim, don't leave it stuck forever
    return current;
  }

  runPipeline(assetId).finally(() => inFlight.delete(assetId));
  return getStatus(assetId);
}

async function runPipeline(assetId) {
  const analysis = await houseUnderstanding.analyzeAsset(assetId).catch((err) => ({ ok: false, failureReason: err.message }));
  // Provider/capability failures are already recorded on the ai_jobs row by
  // houseUnderstanding.service; a thrown error (asset missing, capability
  // disabled) never created one, but getStatus's 'idle' stage covers that
  // case honestly rather than claiming a run that never started.
  if (!analysis.ok) return;

  // Recommendation failure (empty catalog, provider error) does not undo a
  // successful understanding stage — the analysis is still fully usable
  // (manual surface picking, the AI Understand tab, etc.), so this is a
  // partial success, not a pipeline failure. The manual "Generate" button in
  // AI Schemes remains available as a retry path either way.
  await paintRecommendation.generateRecommendations(assetId).catch(() => {});
}

// Derives pipeline stage from the latest ai_jobs row per job_type — no
// separate status column to keep in sync with reality.
//
//   idle           -> understanding never started for this asset
//   understanding  -> house-understanding job running, or succeeded but no
//                     (current) recommendation job exists yet
//   schemes        -> recommendation job running
//   ready          -> recommendation job succeeded, for the current analysis
//   failed         -> whichever stage's job most recently failed
async function getStatus(assetId) {
  const jobs = await aiJobsModel.listJobsForAsset(assetId);
  return deriveStage(jobs);
}

// Pure — no DB access — so it's directly unit-testable (see
// aiPipeline.service.test.js) without standing up a database. `jobs` must
// already be in the same order listJobsForAsset returns (id DESC, i.e. most
// recent first); `.find` below relies on that to pick the latest job of
// each type.
function deriveStage(jobs) {
  const understanding = jobs.find((j) => j.job_type === 'house-understanding');
  const schemes = jobs.find((j) => j.job_type === 'paint-recommendation');

  if (!understanding) return { stage: 'idle', understanding: null, schemes: null };
  if (understanding.status === 'running') return { stage: 'understanding', understanding, schemes: null };
  if (understanding.status === 'failed') return { stage: 'failed', failedAt: 'understanding', understanding, schemes: null };

  // Understanding succeeded. A recommendation job only counts toward
  // "ready" if it ran *after* this analysis (an older batch from a prior
  // analysis doesn't mean this one has schemes yet).
  if (!schemes || schemes.id < understanding.id) return { stage: 'schemes', understanding, schemes: null };
  if (schemes.status === 'running') return { stage: 'schemes', understanding, schemes };
  if (schemes.status === 'failed') return { stage: 'failed', failedAt: 'schemes', understanding, schemes };
  return { stage: 'ready', understanding, schemes };
}

module.exports = { startPipeline, getStatus, deriveStage };
