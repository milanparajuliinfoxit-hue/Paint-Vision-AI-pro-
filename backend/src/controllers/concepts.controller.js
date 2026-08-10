const path = require('path');
const storage = require('../services/storage.service');
const conceptsModel = require('../services/concepts.model');
const projectsModel = require('../services/projects.model');

async function create(req, res, next) {
  try {
    const project = await projectsModel.getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { name, layerColorMap } = req.body;
    if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name is required' });

    // layerColorMap arrives as a JSON string on the multipart path; malformed
    // input is a client error, not a crash.
    let parsedColorMap;
    if (layerColorMap !== undefined && layerColorMap !== null && layerColorMap !== '') {
      try {
        parsedColorMap = typeof layerColorMap === 'string' ? JSON.parse(layerColorMap) : layerColorMap;
      } catch {
        return res.status(400).json({ error: 'layerColorMap must be valid JSON' });
      }
    }

    let thumbnailPath = null;
    if (req.file) {
      const relativeDir = path.join('uploads', 'projects', String(project.id), 'concepts');
      thumbnailPath = storage.saveBuffer(relativeDir, `concept_${Date.now()}.png`, req.file.buffer);
    }

    const concept = await conceptsModel.createConcept({
      projectId: project.id,
      name: name.trim(),
      thumbnailPath,
      layerColorMap: parsedColorMap,
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
