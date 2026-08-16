/**
 * Data layer for AI understanding.
 *
 * ai_jobs           — the versioned audit log for every AI capability run
 *                     (provider, model version, confidence, timing, failure).
 * detected_surfaces — paintable / non-paintable surfaces found in a photo.
 * detected_objects  — removable obstructions (trees, cars, people, ...).
 *
 * All AI pixels (masks) live on disk via storage.service, same pattern as the
 * rest of the app — these tables only store metadata + file references.
 */
const pool = require('../config/db');
const { classifyObject } = require('./ai/objectClassification');

// Throws a typed, catchable error (err.code === 'AI_JOB_ALREADY_RUNNING")
// if a 'running' job of this type already exists for this asset — enforced
// by the database itself (uq_ai_jobs_running, a unique index over a
// generated column that's non-null only while status='running'; see
// schema.sql), not just the in-process inFlightLock.service.js guard. That
// guard is correct for this app's actual single-instance deployment but
// wouldn't hold if it ever ran as multiple instances behind a load
// balancer; this constraint holds regardless, because MySQL enforces it,
// not this process.
async function createJob({ assetId, jobType, provider }) {
  try {
    const [result] = await pool.query(
      `INSERT INTO ai_jobs (asset_id, job_type, provider, status)
       VALUES (?, ?, ?, 'running')`,
      [assetId, jobType, provider]
    );
    return getJob(result.insertId);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY' && err.sqlMessage?.includes('uq_ai_jobs_running')) {
      const running = await getRunningJob(assetId, jobType);
      const typedErr = new Error(`A ${jobType} job is already running for this asset.`);
      typedErr.code = 'AI_JOB_ALREADY_RUNNING';
      typedErr.status = 409;
      typedErr.existingJob = running;
      throw typedErr;
    }
    throw err;
  }
}

async function getRunningJob(assetId, jobType) {
  const [rows] = await pool.query(
    `SELECT * FROM ai_jobs WHERE asset_id = ? AND job_type = ? AND status = 'running' ORDER BY id DESC LIMIT 1`,
    [assetId, jobType]
  );
  return rows[0] || null;
}

async function getJob(id) {
  const [rows] = await pool.query('SELECT * FROM ai_jobs WHERE id = ?', [id]);
  return rows[0] || null;
}

async function markSuccess(id, { confidence, processingTimeMs, modelVersion, outputJson }) {
  await pool.query(
    `UPDATE ai_jobs
     SET status = 'succeeded', confidence = ?, processing_time_ms = ?, model_version = ?, output_json = ?
     WHERE id = ?`,
    [confidence ?? null, processingTimeMs ?? null, modelVersion || null,
      outputJson ? JSON.stringify(outputJson) : null, id]
  );
  return getJob(id);
}

async function markFailed(id, failureReason) {
  await pool.query(
    `UPDATE ai_jobs SET status = 'failed', failure_reason = ? WHERE id = ?`,
    [failureReason ? String(failureReason).slice(0, 500) : null, id]
  );
  return getJob(id);
}

async function listJobsForAsset(assetId) {
  const [rows] = await pool.query(
    'SELECT * FROM ai_jobs WHERE asset_id = ? ORDER BY id DESC LIMIT 50',
    [assetId]
  );
  return rows;
}

async function createSurface({ analysisId, assetId, classKey, displayName, paintable, confidence, maskPath, geometry, averageColor, properties }) {
  const [result] = await pool.query(
    `INSERT INTO detected_surfaces
       (analysis_id, asset_id, class_key, display_name, paintable, confidence, mask_path, geometry, average_color, properties)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [analysisId, assetId, classKey, displayName, paintable ? 1 : 0, confidence ?? null,
      maskPath || null,
      geometry ? JSON.stringify(geometry) : null,
      averageColor ? JSON.stringify(averageColor) : null,
      properties ? JSON.stringify(properties) : null]
  );
  return getSurface(result.insertId);
}

async function getSurface(id) {
  const [rows] = await pool.query('SELECT * FROM detected_surfaces WHERE id = ?', [id]);
  return rows[0] ? decodeSurface(rows[0]) : null;
}

async function createObject({ analysisId, assetId, classKey, displayName, confidence, maskPath, geometry }) {
  const [result] = await pool.query(
    `INSERT INTO detected_objects (analysis_id, asset_id, class_key, display_name, confidence, mask_path, geometry)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [analysisId, assetId, classKey, displayName, confidence ?? null, maskPath || null,
      geometry ? JSON.stringify(geometry) : null]
  );
  return getObject(result.insertId);
}

async function getObject(id) {
  const [rows] = await pool.query('SELECT * FROM detected_objects WHERE id = ?', [id]);
  return rows[0] ? decodeObject(rows[0]) : null;
}

async function listSurfacesForJob(analysisId) {
  const [rows] = await pool.query(
    'SELECT * FROM detected_surfaces WHERE analysis_id = ? ORDER BY id ASC',
    [analysisId]
  );
  return rows.map(decodeSurface);
}

async function listObjectsForJob(analysisId) {
  const [rows] = await pool.query(
    'SELECT * FROM detected_objects WHERE analysis_id = ? ORDER BY id ASC',
    [analysisId]
  );
  return rows.map(decodeObject);
}

// Latest successful house-understanding for an asset, with its surfaces and
// objects attached. Returns null when the asset has not been analyzed.
async function getLatestAnalysis(assetId) {
  const [jobs] = await pool.query(
    `SELECT * FROM ai_jobs
     WHERE asset_id = ? AND job_type = 'house-understanding' AND status = 'succeeded'
     ORDER BY id DESC LIMIT 1`,
    [assetId]
  );
  const job = jobs[0];
  if (!job) return null;
  const output = parseJson(job.output_json) || {};
  return {
    job: decodeJob(job),
    house: output.house || null,
    context: output.context || null,
    surfaces: await listSurfacesForJob(job.id),
    objects: await listObjectsForJob(job.id),
  };
}

// All mask files an asset's analyses reference (surfaces + objects across all
// job runs) — used by asset deletion so AI masks don't linger on disk.
async function listMaskPathsForAsset(assetId) {
  const [surfaceRows] = await pool.query(
    'SELECT mask_path FROM detected_surfaces WHERE asset_id = ? AND mask_path IS NOT NULL',
    [assetId]
  );
  const [objectRows] = await pool.query(
    'SELECT mask_path FROM detected_objects WHERE asset_id = ? AND mask_path IS NOT NULL',
    [assetId]
  );
  return [...surfaceRows, ...objectRows].map((r) => r.mask_path);
}

// Delete the analysis + files for an asset (used when the asset is deleted so
// AI masks don't linger on disk). Rows cascade via FK.
async function deleteAnalysesForAsset(assetId) {
  await pool.query('DELETE FROM ai_jobs WHERE asset_id = ?', [assetId]);
}

function decodeSurface(row) {
  return {
    ...row,
    paintable: row.paintable === 1,
    geometry: parseJson(row.geometry),
    averageColor: parseJson(row.average_color),
    properties: parseJson(row.properties),
  };
}

function decodeObject(row) {
  return {
    ...row,
    // PAINTABLE / NON-PAINTABLE HOUSE COMPONENT / UNRELATED OBJECT — the
    // detected_surfaces `paintable` flag covers the first, this covers the
    // other two. Computed from class_key, not stored (see
    // objectClassification.js) — always in sync with the removal mask.
    category: classifyObject(row.class_key),
    geometry: parseJson(row.geometry),
  };
}

function decodeJob(row) {
  return {
    ...row,
    outputJson: parseJson(row.output_json),
  };
}

function parseJson(v) {
  if (!v) return null;
  // mysql2 auto-parses JSON columns to plain objects on SELECT — pass those
  // through; only strings need parsing.
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

module.exports = {
  createJob, getJob, getRunningJob, markSuccess, markFailed, listJobsForAsset,
  createSurface, getSurface, createObject, getObject,
  listSurfacesForJob, listObjectsForJob, getLatestAnalysis,
  listMaskPathsForAsset, deleteAnalysesForAsset,
};
