const path = require('path');
const storage = require('../services/storage.service');
const projectsModel = require('../services/projects.model');
const aiProxy = require('../services/aiProxy.service');

const MAX_DIMENSION_NOTE = 'Client should downscale to a sane max dimension (e.g. 4000px) before upload.';

async function uploadImage(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

    const job = await projectsModel.createJob({ projectId: req.body.projectId || null, originalPath: '' });
    const relativeDir = path.join('uploads', job.id);
    const filename = 'original.jpg';
    const relativePath = storage.saveBuffer(relativeDir, filename, req.file.buffer);

    await projectsModel.updateJobStatus(job.id, { status: 'uploaded' });
    // Store the real path now that we know the job id folder.
    const pool = require('../config/db');
    await pool.query('UPDATE visualization_jobs SET original_path = ? WHERE id = ?', [relativePath, job.id]);

    res.status(201).json({ jobId: job.id, originalPath: relativePath, note: MAX_DIMENSION_NOTE });
  } catch (err) { next(err); }
}

async function getJob(req, res, next) {
  try {
    const job = await projectsModel.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (err) { next(err); }
}

// Thin proxy: forwards to the hosted AI API and stores the result.
// No image processing happens in this process.
async function requestCleanup(req, res, next) {
  try {
    const job = await projectsModel.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    await projectsModel.updateJobStatus(job.id, { status: 'cleaning' });

    const imageBuffer = storage.readFile(job.original_path);
    const maskBuffer = req.file ? req.file.buffer : null; // optional user-drawn "remove this" mask

    const cleanedBuffer = await aiProxy.callCleanup(imageBuffer, maskBuffer);

    const relativeDir = path.join('uploads', job.id);
    const cleanedPath = storage.saveBuffer(relativeDir, 'cleaned.jpg', cleanedBuffer);

    const updated = await projectsModel.updateJobStatus(job.id, { status: 'cleaned', cleanedPath });
    res.json(updated);
  } catch (err) {
    if (req.params.jobId) {
      await projectsModel.updateJobStatus(req.params.jobId, { status: 'failed', errorMessage: err.message });
    }
    next(err);
  }
}

// Client has already done the recolor rendering on <canvas>; this just stores
// the final PNG it exports, purely for record-keeping/sharing — not processing.
async function saveResult(req, res, next) {
  try {
    const job = await projectsModel.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!req.file) return res.status(400).json({ error: 'No result image uploaded' });

    const { paintId, surfaceLabel } = req.body;
    const relativeDir = path.join('uploads', job.id, 'results');
    const filename = `result_${Date.now()}.png`;
    const relativePath = storage.saveBuffer(relativeDir, filename, req.file.buffer);

    const result = await projectsModel.saveResult({
      jobId: job.id,
      paintId: paintId || null,
      surfaceLabel: surfaceLabel || null,
      resultPath: relativePath,
    });
    res.status(201).json(result);
  } catch (err) { next(err); }
}

async function listResults(req, res, next) {
  try {
    const results = await projectsModel.listResults(req.params.jobId);
    res.json(results);
  } catch (err) { next(err); }
}

module.exports = { uploadImage, getJob, requestCleanup, saveResult, listResults };
