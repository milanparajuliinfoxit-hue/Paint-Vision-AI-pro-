const pool = require('../config/db');
const { v4: uuidv4 } = require('uuid');

async function createProject({ clientName, referenceNote }) {
  const [result] = await pool.query(
    'INSERT INTO projects (client_name, reference_note) VALUES (?, ?)',
    [clientName || null, referenceNote || null]
  );
  return getProject(result.insertId);
}

async function getProject(id) {
  const [rows] = await pool.query('SELECT * FROM projects WHERE id = ?', [id]);
  return rows[0] || null;
}

async function listProjects() {
  const [rows] = await pool.query('SELECT * FROM projects ORDER BY created_at DESC');
  return rows;
}

async function createJob({ projectId, originalPath }) {
  const id = uuidv4();
  await pool.query(
    'INSERT INTO visualization_jobs (id, project_id, original_path, status) VALUES (?, ?, ?, ?)',
    [id, projectId || null, originalPath, 'uploaded']
  );
  return getJob(id);
}

async function getJob(id) {
  const [rows] = await pool.query('SELECT * FROM visualization_jobs WHERE id = ?', [id]);
  return rows[0] || null;
}

async function updateJobStatus(id, { status, cleanedPath, errorMessage }) {
  await pool.query(
    'UPDATE visualization_jobs SET status = ?, cleaned_path = COALESCE(?, cleaned_path), error_message = ? WHERE id = ?',
    [status, cleanedPath || null, errorMessage || null, id]
  );
  return getJob(id);
}

async function saveResult({ jobId, paintId, surfaceLabel, resultPath }) {
  const [result] = await pool.query(
    'INSERT INTO job_results (job_id, paint_id, surface_label, result_path) VALUES (?, ?, ?, ?)',
    [jobId, paintId || null, surfaceLabel || null, resultPath]
  );
  const [rows] = await pool.query('SELECT * FROM job_results WHERE id = ?', [result.insertId]);
  return rows[0];
}

async function listResults(jobId) {
  const [rows] = await pool.query(
    'SELECT * FROM job_results WHERE job_id = ? ORDER BY created_at DESC',
    [jobId]
  );
  return rows;
}

module.exports = {
  createProject, getProject, listProjects,
  createJob, getJob, updateJobStatus,
  saveResult, listResults,
};
