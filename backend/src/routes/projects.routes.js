const express = require('express');
const router = express.Router();
const projectsModel = require('../services/projects.model');
const projectAssetsRoutes = require('./projectAssets.routes');
const historyRoutes = require('./history.routes');
const conceptsRoutes = require('./concepts.routes');
const projectExportsRoutes = require('./projectExports.routes');
const { asyncHandler } = require('../utils/asyncHandler');
const { notFound } = require('../utils/httpError');

router.get('/', asyncHandler(async (req, res) => {
  res.json(await projectsModel.listProjects(req.query));
}));

router.post('/', asyncHandler(async (req, res) => {
  res.status(201).json(await projectsModel.createProject(req.body));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  res.json(await projectsModel.getProjectOrFail(req.params.id));
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const { updatedAt, ...patch } = req.body;
  const project = await projectsModel.updateProject(req.params.id, patch, updatedAt);
  if (!project) throw notFound('Project not found');
  res.json(project);
}));

// The Visualizer only ever opens in the context of a project (requirements
// doc, Section 3) — assets/history/concepts/exports all hang off one here.
router.use('/:projectId/assets', projectAssetsRoutes);
router.use('/:projectId/history', historyRoutes);
router.use('/:projectId/concepts', conceptsRoutes);
router.use('/:projectId/exports', projectExportsRoutes);

module.exports = router;
