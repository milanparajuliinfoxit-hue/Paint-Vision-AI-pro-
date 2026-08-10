const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../config/db');
const projectsModel = require('./projects.model');
const assetsModel = require('./assets.model');

// Same convention as aiJobs.model.test.js — real dev database, skipped if
// unreachable.
let dbAvailable = true;
test.before(async () => {
  try {
    await pool.query('SELECT 1');
  } catch {
    dbAvailable = false;
  }
});

test.after(async () => {
  await pool.end().catch(() => {});
});

async function withTestProject(fn) {
  const project = await projectsModel.createProject({ clientName: 'undo-pointer-test', name: 'undo-pointer-test' });
  try {
    await fn(project);
  } finally {
    await pool.query('DELETE FROM projects WHERE id = ?', [project.id]);
  }
}

// Regression test for the "undo works until reload, then old state comes
// back" bug: hydration on load needs a persisted pointer to know how far
// back a previous session's undo stack actually was, since history_entries
// is append-only and never records an undo/redo itself.
test('a fresh project defaults undo_pointer to -1 (nothing applied)', async (t) => {
  if (!dbAvailable) return t.skip('no database reachable in this environment');

  await withTestProject(async (project) => {
    assert.equal(project.undo_pointer, -1);
  });
});

test('setUndoPointer persists the new position and it round-trips through getProject', async (t) => {
  if (!dbAvailable) return t.skip('no database reachable in this environment');

  await withTestProject(async (project) => {
    const updated = await projectsModel.setUndoPointer(project.id, 5);
    assert.equal(updated.undo_pointer, 5);

    const refetched = await projectsModel.getProject(project.id);
    assert.equal(refetched.undo_pointer, 5);
  });
});

// The general PATCH /:id endpoint (updateProject) enforces optimistic
// concurrency via updated_at. Undo/redo/jump can move the pointer several
// times a second while scrubbing the History tab — if setUndoPointer bumped
// updated_at like a normal field change, every one of those moves would
// invalidate the client's held updated_at and the next legitimate project
// PATCH (rename, status change, etc.) would spuriously 409.
test('setUndoPointer does not change updated_at', async (t) => {
  if (!dbAvailable) return t.skip('no database reachable in this environment');

  await withTestProject(async (project) => {
    const before = await projectsModel.getProject(project.id);
    await new Promise((resolve) => setTimeout(resolve, 1100)); // TIMESTAMP(3) — force a real clock tick
    const after = await projectsModel.setUndoPointer(project.id, 3);
    assert.equal(after.updated_at, before.updated_at);
  });
});

test('setUndoPointer on a non-existent project returns null', async (t) => {
  if (!dbAvailable) return t.skip('no database reachable in this environment');

  const result = await projectsModel.setUndoPointer(999999999, 1);
  assert.equal(result, null);
});

test('deleteProject removes the project and its assets in one transaction', async (t) => {
  if (!dbAvailable) return t.skip('no database reachable in this environment');

  // assets.project_id is ON DELETE SET NULL (schema.sql), so a project
  // delete that drops only the project row would orphan its photos — the
  // model must remove assets up front (layers/ai_jobs then cascade off
  // them).
  await withTestProject(async (project) => {
    const asset = await assetsModel.createAsset({ projectId: project.id, originalPath: 'delete-test/original.jpg' });

    assert.equal(await projectsModel.deleteProject(project.id), true);
    assert.equal(await projectsModel.getProject(project.id), null);

    const [rows] = await pool.query('SELECT id FROM assets WHERE id = ?', [asset.id]);
    assert.equal(rows.length, 0);
  });
});

test('deleteProject returns false for a non-existent project', async (t) => {
  if (!dbAvailable) return t.skip('no database reachable in this environment');

  assert.equal(await projectsModel.deleteProject(999999999), false);
});
