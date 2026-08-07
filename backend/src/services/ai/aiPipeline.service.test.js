const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveStage } = require('./aiPipeline.service');

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
