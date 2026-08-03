const pool = require('../config/db');

async function createExportJob({ projectId, format, comparisonMode }) {
  const [result] = await pool.query(
    'INSERT INTO export_jobs (project_id, format, comparison_mode, status) VALUES (?, ?, ?, ?)',
    [projectId, format, comparisonMode || null, 'pending']
  );
  return getExportJob(result.insertId);
}

async function getExportJob(id) {
  const [rows] = await pool.query('SELECT * FROM export_jobs WHERE id = ?', [id]);
  return rows[0] || null;
}

async function listForProject(projectId) {
  const [rows] = await pool.query(
    'SELECT * FROM export_jobs WHERE project_id = ? ORDER BY created_at DESC',
    [projectId]
  );
  return rows;
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
