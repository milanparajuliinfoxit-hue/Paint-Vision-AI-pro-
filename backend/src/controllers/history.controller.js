const historyModel = require('../services/history.model');
const projectsModel = require('../services/projects.model');

// Append-only log of undo/redo command entries — persisted per project so
// the history stack survives a refresh (requirements doc, Section 5.3/7).
async function append(req, res, next) {
  try {
    const project = await projectsModel.getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { action, beforeState, afterState, supersedeIds } = req.body;
    if (!action) return res.status(400).json({ error: 'action is required' });

    const entry = await historyModel.appendEntry({ projectId: project.id, action, beforeState, afterState, supersedeIds });
    res.status(201).json(entry);
  } catch (err) { next(err); }
}

async function list(req, res, next) {
  try {
    res.json(await historyModel.listForProject(req.params.projectId));
  } catch (err) { next(err); }
}

module.exports = { append, list };
