const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../config/db');
const projectsModel = require('./projects.model');
const assetsModel = require('./assets.model');
const aiJobsModel = require('./aiJobs.model');

// These hit the real dev database (same one `npm run dev` uses) — there is
// no separate test DB configured for this project (see final report's
// remaining limitations). Skipped automatically if the DB isn't reachable,
// so `npm test` still works in an environment with no MySQL running.
let dbAvailable = true;
test.before(async () => {
  try {
    await pool.query('SELECT 1');
  } catch {
    dbAvailable = false;
  }
});

// mysql2's pool keeps its sockets open (keepAlive) so the process can be
// reached again quickly — that's correct for a long-running server, but it
// means `node --test` never sees an empty event loop and hangs forever
// after the last test finishes unless something closes the pool.
test.after(async () => {
  await pool.end().catch(() => {});
});

async function withTestAsset(fn) {
  const project = await projectsModel.createProject({ clientName: 'db-lock-test', name: 'db-lock-test' });
  const asset = await assetsModel.createAsset({ projectId: project.id, originalPath: 'x.jpg' });
  try {
    await fn(asset.id);
  } finally {
    await pool.query('DELETE FROM projects WHERE id = ?', [project.id]); // cascades to assets/ai_jobs
  }
}

test('the database itself rejects a second concurrent running job for the same asset+type — a real constraint, not just the in-process lock', async (t) => {
  if (!dbAvailable) return t.skip('no database reachable in this environment');

  await withTestAsset(async (assetId) => {
    await aiJobsModel.createJob({ assetId, jobType: 'house-understanding', provider: 'mock' });

    await assert.rejects(
      () => aiJobsModel.createJob({ assetId, jobType: 'house-understanding', provider: 'mock' }),
      (err) => {
        assert.equal(err.code, 'AI_JOB_ALREADY_RUNNING');
        assert.equal(err.status, 409);
        assert.ok(err.existingJob);
        return true;
      }
    );
  });
});

test('a different job_type on the same asset is not blocked by the constraint', async (t) => {
  if (!dbAvailable) return t.skip('no database reachable in this environment');

  await withTestAsset(async (assetId) => {
    await aiJobsModel.createJob({ assetId, jobType: 'house-understanding', provider: 'mock' });
    const rec = await aiJobsModel.createJob({ assetId, jobType: 'paint-recommendation', provider: 'catalog' });
    assert.ok(rec.id);
  });
});

test('a new job is allowed once the previous one has settled (succeeded/failed)', async (t) => {
  if (!dbAvailable) return t.skip('no database reachable in this environment');

  await withTestAsset(async (assetId) => {
    const first = await aiJobsModel.createJob({ assetId, jobType: 'house-understanding', provider: 'mock' });
    await aiJobsModel.markSuccess(first.id, { confidence: 1, processingTimeMs: 1, modelVersion: 'test', outputJson: {} });
    const second = await aiJobsModel.createJob({ assetId, jobType: 'house-understanding', provider: 'mock' });
    assert.notEqual(second.id, first.id);
  });
});
