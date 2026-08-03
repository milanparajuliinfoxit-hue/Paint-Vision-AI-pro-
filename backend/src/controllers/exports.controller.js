const path = require('path');
const storage = require('../services/storage.service');
const exportsModel = require('../services/exports.model');
const projectsModel = require('../services/projects.model');

const SUPPORTED_FORMATS = ['png', 'side-by-side-jpg'];
const DEFERRED_FORMATS = ['pdf'];

// Synchronous today: the client renders the comparison composite on
// <canvas> and uploads it in the same request, so the job resolves to
// "ready" immediately — there's no render worker/queue yet. PDF export with
// a dealer-branding header needs a real render pipeline; flagged rather
// than faked as a PNG (requirements doc, Section 8/9).
async function create(req, res, next) {
  try {
    const project = await projectsModel.getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { format, comparisonMode } = req.body;
    if (DEFERRED_FORMATS.includes(format)) {
      return res.status(501).json({
        error: `Export format "${format}" isn't implemented yet — it needs a render pipeline beyond the client canvas. Use "png" or "side-by-side-jpg" for now.`,
      });
    }
    if (!SUPPORTED_FORMATS.includes(format)) {
      return res.status(400).json({ error: `Unsupported format "${format}"` });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No rendered file uploaded' });
    }

    const job = await exportsModel.createExportJob({ projectId: project.id, format, comparisonMode });
    const relativeDir = path.join('uploads', 'projects', String(project.id), 'exports');
    const ext = format === 'png' ? 'png' : 'jpg';
    const relativePath = storage.saveBuffer(relativeDir, `export_${job.id}.${ext}`, req.file.buffer);

    const updated = await exportsModel.markReady(job.id, relativePath);
    res.status(201).json(updated);
  } catch (err) { next(err); }
}

async function get(req, res, next) {
  try {
    const job = await exportsModel.getExportJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Export job not found' });
    res.json(job);
  } catch (err) { next(err); }
}

async function list(req, res, next) {
  try {
    res.json(await exportsModel.listForProject(req.params.projectId));
  } catch (err) { next(err); }
}

module.exports = { create, get, list };
