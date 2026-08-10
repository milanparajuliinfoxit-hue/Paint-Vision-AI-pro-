const storage = require('../services/storage.service');
const exportsModel = require('../services/exports.model');
const projectsModel = require('../services/projects.model');
const { asyncHandler } = require('../utils/asyncHandler');
const { badRequest, notFound, notImplemented } = require('../utils/httpError');

const SUPPORTED_FORMATS = ['png', 'side-by-side-jpg'];
const DEFERRED_FORMATS = ['pdf'];

// Synchronous today: the client renders the comparison composite on
// <canvas> and uploads it in the same request, so the job resolves to
// "ready" immediately — there's no render worker/queue yet. PDF export with
// a dealer-branding header needs a real render pipeline; flagged rather
// than faked as a PNG (requirements doc, Section 8/9).
const create = asyncHandler(async (req, res) => {
  const project = await projectsModel.getProjectOrFail(req.params.projectId);

  const { format, comparisonMode } = req.body;
  if (DEFERRED_FORMATS.includes(format)) {
    throw notImplemented(
      `Export format "${format}" isn't implemented yet — it needs a render pipeline beyond the client canvas. Use "png" or "side-by-side-jpg" for now.`
    );
  }
  if (!SUPPORTED_FORMATS.includes(format)) throw badRequest(`Unsupported format "${format}"`);
  if (!req.file) throw badRequest('No rendered file uploaded');

  const job = await exportsModel.createExportJob({ projectId: project.id, format, comparisonMode });
  const ext = format === 'png' ? 'png' : 'jpg';
  const relativePath = storage.saveBuffer(
    storage.projectDir(project.id, 'exports'),
    `export_${job.id}.${ext}`,
    req.file.buffer
  );

  const updated = await exportsModel.markReady(job.id, relativePath);
  res.status(201).json(updated);
});

const get = asyncHandler(async (req, res) => {
  const job = await exportsModel.getExportJob(req.params.id);
  if (!job) throw notFound('Export job not found');
  res.json(job);
});

const list = asyncHandler(async (req, res) => {
  res.json(await exportsModel.listForProject(req.params.projectId));
});

module.exports = { create, get, list };
