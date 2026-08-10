const historyModel = require('../services/history.model');
const projectsModel = require('../services/projects.model');
const { asyncHandler } = require('../utils/asyncHandler');
const { badRequest } = require('../utils/httpError');

// Append-only log of undo/redo command entries — persisted per project so
// the history stack survives a refresh (requirements doc, Section 5.3/7).
const append = asyncHandler(async (req, res) => {
  const project = await projectsModel.getProjectOrFail(req.params.projectId);

  const { action, beforeState, afterState } = req.body;
  if (!action) throw badRequest('action is required');

  const entry = await historyModel.appendEntry({ projectId: project.id, action, beforeState, afterState });
  res.status(201).json(entry);
});

const list = asyncHandler(async (req, res) => {
  res.json(await historyModel.listForProject(req.params.projectId));
});

module.exports = { append, list };
