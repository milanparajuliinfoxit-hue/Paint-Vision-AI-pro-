const storage = require('../services/storage.service');
const conceptsModel = require('../services/concepts.model');
const projectsModel = require('../services/projects.model');
const { asyncHandler } = require('../utils/asyncHandler');
const { badRequest } = require('../utils/httpError');

const create = asyncHandler(async (req, res) => {
  const project = await projectsModel.getProjectOrFail(req.params.projectId);

  const { name, layerColorMap } = req.body;
  if (!name) throw badRequest('name is required');

  let thumbnailPath = null;
  if (req.file) {
    thumbnailPath = storage.saveBuffer(
      storage.projectDir(project.id, 'concepts'),
      `concept_${Date.now()}.png`,
      req.file.buffer
    );
  }

  const concept = await conceptsModel.createConcept({
    projectId: project.id,
    name,
    thumbnailPath,
    layerColorMap: layerColorMap ? JSON.parse(layerColorMap) : undefined,
  });
  res.status(201).json(concept);
});

const list = asyncHandler(async (req, res) => {
  res.json(await conceptsModel.listForProject(req.params.projectId));
});

module.exports = { create, list };
