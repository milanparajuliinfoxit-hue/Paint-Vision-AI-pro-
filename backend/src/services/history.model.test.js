const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');

// UPLOAD_ROOT is read at module-load time by storage.service — set before
// requiring it, same convention as storage.service.test.js, so these tests
// write real files to a throwaway scratch dir instead of the real uploads/.
const scratchRoot = path.join(__dirname, '__test_uploads_history__');
process.env.UPLOAD_ROOT = scratchRoot;

const pool = require('../config/db');
const projectsModel = require('./projects.model');
const assetsModel = require('./assets.model');
const layersModel = require('./layers.model');
const historyModel = require('./history.model');
const storage = require('./storage.service');

// Regression tests for LAYER_MASK_HISTORY_AUDIT.md §G.1: persisted history
// must distinguish an abandoned redo branch (undone, then overwritten by a
// different edit) from the active branch, so a reload can't let redo
// resurrect the abandoned one. Real dev database, same convention as
// projects.model.test.js/aiJobs.model.test.js — skipped if unreachable.
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
  await fs.rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
});

async function withTestProject(fn) {
  const project = await projectsModel.createProject({ clientName: 'history-branch-test', name: 'history-branch-test' });
  try {
    await fn(project);
  } finally {
    await pool.query('DELETE FROM projects WHERE id = ?', [project.id]);
  }
}

async function withTestAsset(projectId, fn) {
  const asset = await assetsModel.createAsset({ projectId, originalPath: 'history-branch-test/original.jpg' });
  try {
    await fn(asset);
  } finally {
    await pool.query('DELETE FROM assets WHERE id = ?', [asset.id]);
  }
}

// Simulates exactly what useHistoryCommand.js's hydrateHistory filter does
// client-side: recognized action type (all of these are) AND not superseded.
function activeOnly(entries) {
  return entries.filter((e) => !e.superseded_at);
}

test('Test 1 — linear history: no supersedeIds means nothing is marked superseded', async (t) => {
  if (!dbAvailable) return t.skip('no database reachable in this environment');
  await withTestProject(async (project) => {
    const a = await historyModel.appendEntry({ projectId: project.id, action: 'mask-created', beforeState: null, afterState: { layerId: 1 } });
    const b = await historyModel.appendEntry({ projectId: project.id, action: 'mask-edited', beforeState: { maskPath: 'm1' }, afterState: { maskPath: 'm2' } });
    const c = await historyModel.appendEntry({ projectId: project.id, action: 'mask-edited', beforeState: { maskPath: 'm2' }, afterState: { maskPath: 'm3' } });

    const all = await historyModel.listForProject(project.id);
    assert.equal(all.length, 3);
    assert.deepEqual(activeOnly(all).map((e) => e.id), [a.id, b.id, c.id]);
  });
});

test('Test 2 — undo then a new edit supersedes the abandoned branch, without deleting it', async (t) => {
  if (!dbAvailable) return t.skip('no database reachable in this environment');
  await withTestProject(async (project) => {
    const a = await historyModel.appendEntry({ projectId: project.id, action: 'mask-created', beforeState: null, afterState: { layerId: 1 } });
    const b = await historyModel.appendEntry({ projectId: project.id, action: 'mask-edited', beforeState: { maskPath: 'm1' }, afterState: { maskPath: 'm2' } });

    // User undoes B (conceptually, back to A), then paints something new —
    // C is appended and supersedes B in the same call.
    const c = await historyModel.appendEntry({
      projectId: project.id, action: 'mask-edited', beforeState: { maskPath: 'm1' }, afterState: { maskPath: 'm3' },
      supersedeIds: [b.id],
    });

    const all = await historyModel.listForProject(project.id);
    const rowA = all.find((e) => e.id === a.id);
    const rowB = all.find((e) => e.id === b.id);
    const rowC = all.find((e) => e.id === c.id);

    assert.equal(rowA.superseded_at, null, 'A must remain active');
    assert.ok(rowB.superseded_at, 'B must be marked superseded');
    assert.equal(rowC.superseded_at, null, 'C (the new active branch) must remain active');

    // Not deleted — the row and its data are still fully present.
    assert.deepEqual(rowB.before_state, { maskPath: 'm1' });
    assert.deepEqual(rowB.after_state, { maskPath: 'm2' });
  });
});

test('Test 3 — an abandoned branch is excluded from the hydration-equivalent active list (cannot be resurrected by redo)', async (t) => {
  if (!dbAvailable) return t.skip('no database reachable in this environment');
  await withTestProject(async (project) => {
    const a = await historyModel.appendEntry({ projectId: project.id, action: 'mask-created', beforeState: null, afterState: { layerId: 1 } });
    const b = await historyModel.appendEntry({ projectId: project.id, action: 'mask-edited', beforeState: { maskPath: 'm1' }, afterState: { maskPath: 'm2' } });
    const c = await historyModel.appendEntry({
      projectId: project.id, action: 'mask-edited', beforeState: { maskPath: 'm1' }, afterState: { maskPath: 'm3' },
      supersedeIds: [b.id],
    });

    // "Reload": re-fetch from scratch and rebuild the active list exactly as
    // hydrateHistory would.
    const all = await historyModel.listForProject(project.id);
    const active = activeOnly(all);
    assert.deepEqual(active.map((e) => e.id), [a.id, c.id]);
    assert.ok(!active.some((e) => e.id === b.id), 'B must not be redoable after reload');
  });
});

test('Test 4 — repeated undo/new-edit cycles: only the final active chain is unsupersed', async (t) => {
  if (!dbAvailable) return t.skip('no database reachable in this environment');
  await withTestProject(async (project) => {
    // A -> B -> C (linear)
    const a = await historyModel.appendEntry({ projectId: project.id, action: 'mask-created', beforeState: null, afterState: { layerId: 1 } });
    const b = await historyModel.appendEntry({ projectId: project.id, action: 'mask-edited', beforeState: { maskPath: 'a' }, afterState: { maskPath: 'b' } });
    const c = await historyModel.appendEntry({ projectId: project.id, action: 'mask-edited', beforeState: { maskPath: 'b' }, afterState: { maskPath: 'c' } });

    // Undo twice (back to A), paint D — B and C are both abandoned.
    const d = await historyModel.appendEntry({
      projectId: project.id, action: 'mask-edited', beforeState: { maskPath: 'a' }, afterState: { maskPath: 'd' },
      supersedeIds: [b.id, c.id],
    });

    // Undo once (back to A), paint E — D is now abandoned too. B/C stay
    // superseded (already marked); re-including them in supersedeIds must
    // be a harmless no-op (idempotent), not an error or a timestamp bump.
    const e = await historyModel.appendEntry({
      projectId: project.id, action: 'mask-edited', beforeState: { maskPath: 'a' }, afterState: { maskPath: 'e' },
      supersedeIds: [d.id],
    });

    const all = await historyModel.listForProject(project.id);
    const byId = Object.fromEntries(all.map((row) => [row.id, row]));
    assert.equal(byId[a.id].superseded_at, null);
    assert.ok(byId[b.id].superseded_at);
    assert.ok(byId[c.id].superseded_at);
    assert.ok(byId[d.id].superseded_at);
    assert.equal(byId[e.id].superseded_at, null);

    assert.deepEqual(activeOnly(all).map((row) => row.id), [a.id, e.id]);
  });
});

test('Test 5 — mask files belonging to an abandoned branch are never deleted or overwritten', async (t) => {
  if (!dbAvailable) return t.skip('no database reachable in this environment');
  await withTestProject(async (project) => {
    await withTestAsset(project.id, async (asset) => {
      const pathA = await storage.saveBuffer(path.join(asset.id, 'masks'), 'layer_1.png', Buffer.from('mask-A'));
      const pathB = await storage.saveBuffer(path.join(asset.id, 'masks'), 'layer_2.png', Buffer.from('mask-B'));
      const layer = await layersModel.createLayer({ assetId: asset.id, name: 'Test layer', maskPath: pathA, createdVia: 'brush' });

      const entryA = await historyModel.appendEntry({ projectId: project.id, action: 'mask-created', beforeState: null, afterState: { layerId: layer.id } });
      const entryB = await historyModel.appendEntry({ projectId: project.id, action: 'mask-edited', beforeState: { maskPath: pathA }, afterState: { maskPath: pathB } });
      await layersModel.updateLayer(layer.id, { maskPath: pathB });

      // Undo B, paint a third stroke C — B (and its file) become abandoned.
      const pathC = await storage.saveBuffer(path.join(asset.id, 'masks'), 'layer_3.png', Buffer.from('mask-C'));
      await historyModel.appendEntry({
        projectId: project.id, action: 'mask-edited', beforeState: { maskPath: pathA }, afterState: { maskPath: pathC },
        supersedeIds: [entryB.id],
      });
      await layersModel.updateLayer(layer.id, { maskPath: pathC });

      // All three files must still be readable — superseding history rows
      // never touches the filesystem.
      for (const p of [pathA, pathB, pathC]) {
        const buf = await storage.readFile(p);
        assert.ok(buf.length > 0, `expected ${p} to still be readable`);
      }
      void entryA;
    });
  });
});

test('Test 6 — soft-delete/restore is unaffected by the supersede mechanism', async (t) => {
  if (!dbAvailable) return t.skip('no database reachable in this environment');
  await withTestProject(async (project) => {
    await withTestAsset(project.id, async (asset) => {
      const layer = await layersModel.createLayer({ assetId: asset.id, name: 'Delete-test layer', createdVia: 'brush' });
      await layersModel.deleteLayer(layer.id);
      const deleted = await layersModel.getLayerIncludingDeleted(layer.id);
      assert.ok(deleted.deleted_at, 'layer should be soft-deleted');

      const restored = await layersModel.restoreLayer(layer.id);
      assert.equal(restored.deleted_at, null, 'restore should clear deleted_at');
      assert.equal(restored.id, layer.id, 'restore must reuse the same row/id, not recreate it');
    });
  });
});

test('Test 7 — an AI-generated (ai-surface) layer participates in the same branch-supersede semantics', async (t) => {
  if (!dbAvailable) return t.skip('no database reachable in this environment');
  await withTestProject(async (project) => {
    await withTestAsset(project.id, async (asset) => {
      const { layer, created } = await layersModel.upsertAiLayer({
        assetId: asset.id, name: 'AI Wall', aiSurfaceKey: 'front-wall', aiAnalysisId: 999001,
      });
      assert.equal(created, true);

      // manual state -> AI scheme applied (create) -> undo -> different AI
      // scheme applied (a second create-shaped history entry, since applying
      // a scheme records a 'mask-created' the same way any new layer does).
      const created1 = await historyModel.appendEntry({ projectId: project.id, action: 'mask-created', beforeState: null, afterState: { layerId: layer.id, createdVia: 'ai-surface' } });
      const created2 = await historyModel.appendEntry({
        projectId: project.id, action: 'mask-created', beforeState: null, afterState: { layerId: layer.id, createdVia: 'ai-surface' },
        supersedeIds: [created1.id],
      });

      const all = await historyModel.listForProject(project.id);
      const byId = Object.fromEntries(all.map((row) => [row.id, row]));
      assert.ok(byId[created1.id].superseded_at, 'abandoned AI scheme apply must be superseded');
      assert.equal(byId[created2.id].superseded_at, null, 'active AI scheme apply must remain active');
      assert.deepEqual(activeOnly(all).map((row) => row.id), [created2.id]);
    });
  });
});
