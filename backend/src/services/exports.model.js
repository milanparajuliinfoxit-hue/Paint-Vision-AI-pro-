const pool = require('../config/db');
const { findById, listByColumn } = require('./db.helpers');

async function createExportJob({ projectId, format, comparisonMode }) {
  const [result] = await pool.query(
    'INSERT INTO export_jobs (project_id, format, comparison_mode, status) VALUES (?, ?, ?, ?)',
    [projectId, format, comparisonMode || null, 'pending']
  );
  return getExportJob(result.insertId);
}

function getExportJob(id) {
  return findById('export_jobs', id);
}

function listForProject(projectId) {
  return listByColumn('export_jobs', 'project_id', projectId, 'created_at DESC');
}

async function markReady(id, filePath) {
  await pool.query('UPDATE export_jobs SET status = ?, file_path = ? WHERE id = ?', ['ready', filePath, id]);
  return getExportJob(id);
}

async function markFailed(id) {
  await pool.query('UPDATE export_jobs SET status = ? WHERE id = ?', ['failed', id]);
  return getExportJob(id);
}

module.exports = { createExportJob, getExportJob, listForProject, markReady, markFailed };
