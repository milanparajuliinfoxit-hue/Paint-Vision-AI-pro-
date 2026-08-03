const express = require('express');
const router = express.Router();
const projectsModel = require('../services/projects.model');
const projectAssetsRoutes = require('./projectAssets.routes');
const historyRoutes = require('./history.routes');
const conceptsRoutes = require('./concepts.routes');
const projectExportsRoutes = require('./projectExports.routes');

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

// The Visualizer only ever opens in the context of a project (requirements
// doc, Section 3) — assets/history/concepts/exports all hang off one here.
router.use('/:projectId/assets', projectAssetsRoutes);
router.use('/:projectId/history', historyRoutes);
router.use('/:projectId/concepts', conceptsRoutes);
router.use('/:projectId/exports', projectExportsRoutes);

module.exports = router;
