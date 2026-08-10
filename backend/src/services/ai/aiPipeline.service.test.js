const test = require('node:test');
const assert = require('node:assert/strict');
const aiJobsModel = require('../aiJobs.model');
const houseUnderstanding = require('./houseUnderstanding.service');
const paintRecommendation = require('./paintRecommendation.service');
const { deriveStage, startPipeline } = require('./aiPipeline.service');

// listJobsForAsset orders id DESC (most recent first) — these fixtures
// follow that convention since deriveStage relies on .find() picking the
// first (= latest) match per job_type.
function job(overrides) {
  return { job_type: 'house-understanding', status: 'succeeded', id: 1, ...overrides };
}

test('no jobs at all -> idle', () => {
  assert.equal(deriveStage([]).stage, 'idle');
});

test('understanding running -> understanding stage', () => {
  const jobs = [job({ id: 5, status: 'running' })];
  assert.equal(deriveStage(jobs).stage, 'understanding');
});

test('understanding failed -> failed at understanding', () => {
  const jobs = [job({ id: 5, status: 'failed' })];
  const result = deriveStage(jobs);
  assert.equal(result.stage, 'failed');
  assert.equal(result.failedAt, 'understanding');
});

test('understanding succeeded, no recommendation job yet -> schemes stage', () => {
  const jobs = [job({ id: 5, status: 'succeeded' })];
  assert.equal(deriveStage(jobs).stage, 'schemes');
});

test('understanding succeeded, recommendation running -> schemes stage', () => {
  const jobs = [
    { job_type: 'paint-recommendation', status: 'running', id: 6 },
    job({ id: 5, status: 'succeeded' }),
  ];
  assert.equal(deriveStage(jobs).stage, 'schemes');
});

test('understanding succeeded, recommendation succeeded -> ready', () => {
  const jobs = [
    { job_type: 'paint-recommendation', status: 'succeeded', id: 6 },
    job({ id: 5, status: 'succeeded' }),
  ];
  assert.equal(deriveStage(jobs).stage, 'ready');
});

test('understanding succeeded, recommendation failed -> failed at schemes', () => {
  const jobs = [
    { job_type: 'paint-recommendation', status: 'failed', id: 6 },
    job({ id: 5, status: 'succeeded' }),
  ];
  const result = deriveStage(jobs);
  assert.equal(result.stage, 'failed');
  assert.equal(result.failedAt, 'schemes');
});

test('a recommendation job from a PRIOR analysis does not count as ready for a NEW one', () => {
  // Re-analyze created a newer understanding job (id 10) than the last
  // successful recommendation batch (id 6, from the old analysis id 5).
  const jobs = [
    job({ id: 10, status: 'succeeded' }),
    { job_type: 'paint-recommendation', status: 'succeeded', id: 6 },
    job({ id: 5, status: 'succeeded' }),
  ];
  assert.equal(deriveStage(jobs).stage, 'schemes');
});

// Regression test for a real concurrency bug: the original implementation
// checked `inFlight`, then awaited a DB read, then claimed the slot — two
// near-simultaneous calls could both pass the check before either claimed
// it, so both ran the pipeline. The fix claims the slot synchronously
// before the first await.
test('two concurrent startPipeline calls for the same asset only run the pipeline once', async () => {
  const origList = aiJobsModel.listJobsForAsset;
  const origAnalyze = houseUnderstanding.analyzeAsset;
  const origGenerate = paintRecommendation.generateRecommendations;

  let analyzeCalls = 0;
  aiJobsModel.listJobsForAsset = async () => []; // always "idle" — nothing short-circuits the race
  houseUnderstanding.analyzeAsset = async () => {
    analyzeCalls++;
    await new Promise((resolve) => setTimeout(resolve, 20)); // hold the race window open
    return { ok: false, failureReason: 'test stub, not a real failure' };
  };
  paintRecommendation.generateRecommendations = async () => {};

  try {
    await Promise.all([startPipeline('asset-race'), startPipeline('asset-race')]);
    assert.equal(analyzeCalls, 1, `expected exactly one analyzeAsset call, got ${analyzeCalls}`);
  } finally {
    aiJobsModel.listJobsForAsset = origList;
    houseUnderstanding.analyzeAsset = origAnalyze;
    paintRecommendation.generateRecommendations = origGenerate;
  }
});

test('startPipeline releases its claim after a no-op return (already-ready asset) — a later call is not blocked forever', async () => {
  const origList = aiJobsModel.listJobsForAsset;
  aiJobsModel.listJobsForAsset = async () => [
    { job_type: 'paint-recommendation', status: 'succeeded', id: 2 },
    { job_type: 'house-understanding', status: 'succeeded', id: 1 },
  ];
  try {
    const first = await startPipeline('asset-ready');
    assert.equal(first.stage, 'ready');
    // If the claim wasn't released, this would hang waiting on inFlight
    // forever instead of resolving — the `await` here is the actual assertion.
    const second = await startPipeline('asset-ready');
    assert.equal(second.stage, 'ready');
  } finally {
    aiJobsModel.listJobsForAsset = origList;
  }
});
