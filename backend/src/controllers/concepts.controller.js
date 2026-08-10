const path = require('path');
const storage = require('../services/storage.service');
const conceptsModel = require('../services/concepts.model');
const projectsModel = require('../services/projects.model');

async function create(req, res, next) {
  try {
    const project = await projectsModel.getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { name, layerColorMap } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    let thumbnailPath = null;
    if (req.file) {
      const relativeDir = path.join('uploads', 'projects', String(project.id), 'concepts');
      thumbnailPath = await storage.saveBuffer(relativeDir, `concept_${Date.now()}.png`, req.file.buffer);
    }

    const concept = await conceptsModel.createConcept({
      projectId: project.id,
      name,
      thumbnailPath,
      layerColorMap: layerColorMap ? JSON.parse(layerColorMap) : undefined,
    });
    res.status(201).json(concept);
  } catch (err) { next(err); }
}

async function list(req, res, next) {
  try {
    res.json(await conceptsModel.listForProject(req.params.projectId));
  } catch (err) { next(err); }
}

module.exports = { create, list };
