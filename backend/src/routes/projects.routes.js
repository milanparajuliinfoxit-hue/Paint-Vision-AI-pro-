const express = require('express');
const path = require('path');
const router = express.Router();
const projectsModel = require('../services/projects.model');
const assetsModel = require('../services/assets.model');
const storage = require('../services/storage.service');
const projectAssetsRoutes = require('./projectAssets.routes');
const historyRoutes = require('./history.routes');
const conceptsRoutes = require('./concepts.routes');
const projectExportsRoutes = require('./projectExports.routes');
const logger = require('../services/logger.service');

router.get('/', async (req, res, next) => {
  try { res.json(await projectsModel.listProjects(req.query)); } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const project = await projectsModel.createProject(req.body);
    res.status(201).json(project);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const project = await projectsModel.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { updatedAt, ...patch } = req.body;
    const project = await projectsModel.updateProject(req.params.id, patch, updatedAt);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  } catch (err) { next(err); }
});

// Persists where the local undo/redo stack is positioned so a reload can
// resume from there instead of assuming every logged action is still
// applied (see schema.sql's undo_pointer comment for why that assumption
// is wrong). Deliberately not routed through the PATCH above — see
// projects.model.js's setUndoPointer for why it skips the optimistic-
// concurrency check.
router.patch('/:id/undo-pointer', async (req, res, next) => {
  try {
    const { pointer } = req.body;
    if (!Number.isInteger(pointer) || pointer < -1) {
      return res.status(400).json({ error: 'pointer must be an integer >= -1' });
    }
    const project = await projectsModel.setUndoPointer(req.params.id, pointer);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  const startedAt = Date.now();
  const logCtx = { requestId: req.requestId, projectId: req.params.id };
  logger.info({ event: 'project.delete.requested', ...logCtx });

  try {
    const project = await projectsModel.getProject(req.params.id);
    if (!project) {
      logger.info({ event: 'project.delete.not_found', ...logCtx, durationMs: Date.now() - startedAt });
      return res.status(404).json({ error: 'Project not found' });
    }

    // Only need the asset ids up front — every file a project or its assets
    // own is removed by tree, not enumerated file-by-file (see storage
    // .service.js's removeTree for why: enumerating known files/subfolders
    // individually is exactly what previously left orphaned uploads/
    // <assetId> directories on disk after a project was already deleted).
    const assets = await assetsModel.listAssetsForProject(project.id);

    const deleted = await projectsModel.deleteProject(project.id);
    if (!deleted) {
      logger.info({ event: 'project.delete.not_found', ...logCtx, durationMs: Date.now() - startedAt });
      return res.status(404).json({ error: 'Project not found' });
    }

    // Best-effort disk cleanup after the DB commit — an orphaned directory
    // must never roll back a successful delete. Each asset owns two real,
    // disjoint locations on disk (a historical inconsistency, not by
    // design): UPLOAD_ROOT/<assetId>/ for original/cleaned photos + AI
    // masks, and UPLOAD_ROOT/uploads/<assetId>/ for layer masks (see
    // layers.controller.js's relativeDir). Both get removed in full.
    const cleanupErrors = [];
    async function removeTreeLogged(relativeDir, label) {
      try {
        await storage.removeTree(relativeDir);
      } catch (err) {
        cleanupErrors.push({ label, relativeDir, error: err.message });
      }
    }
    for (const asset of assets) {
      await removeTreeLogged(asset.id, 'asset');
      await removeTreeLogged(path.join('uploads', asset.id), 'asset-masks');
    }
    await removeTreeLogged(path.join('uploads', 'projects', String(project.id)), 'project');

    if (cleanupErrors.length) {
      // Disk cleanup failing doesn't undo the (already-committed) DB
      // delete — this is surfaced loudly (error-level log, not swallowed)
      // for someone to investigate, not turned into a failed HTTP response
      // for a delete that, from the data's perspective, genuinely succeeded.
      logger.error({ event: 'project.delete.filesystem_cleanup_failed', ...logCtx, cleanupErrors });
    } else {
      logger.info({ event: 'project.delete.filesystem_cleanup_completed', ...logCtx, assetCount: assets.length });
    }

    logger.info({
      event: 'project.delete.completed',
      ...logCtx,
      assetCount: assets.length,
      durationMs: Date.now() - startedAt,
    });
    res.status(204).end();
  } catch (err) {
    // errorHandler.middleware.js also logs a generic request.failed event
    // with the stack trace — this one is domain-specific (searchable by
    // project.delete.failed / projectId without needing to know it happened
    // inside a DELETE /api/projects/:id request).
    logger.error({ event: 'project.delete.failed', ...logCtx, durationMs: Date.now() - startedAt, error: err.message });
    next(err);
  }
});

// The Visualizer only ever opens in the context of a project (requirements
// doc, Section 3) — assets/history/concepts/exports all hang off one here.
router.use('/:projectId/assets', projectAssetsRoutes);
router.use('/:projectId/history', historyRoutes);
router.use('/:projectId/concepts', conceptsRoutes);
router.use('/:projectId/exports', projectExportsRoutes);

module.exports = router;
