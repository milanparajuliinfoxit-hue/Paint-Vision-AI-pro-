const express = require('express');
const router = express.Router();
const projectsModel = require('../services/projects.model');

router.get('/', async (req, res, next) => {
  try { res.json(await projectsModel.listProjects()); } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const project = await projectsModel.createProject(req.body);
    res.status(201).json(project);
  } catch (err) { next(err); }
});

module.exports = router;
