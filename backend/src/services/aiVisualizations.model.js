/**
 * Data layer for generated Gemini visualizations (ai_visualizations table).
 *
 * Mirrors aiJobs.model.js's conventions (plain pool.query, JSON columns
 * encoded/decoded at the boundary, no ORM). One row per generated image; the
 * pixels live on disk via storage.service, same as every other image in
 * this app — this table only stores metadata + a file reference.
 */
const pool = require('../config/db');

async function createPending({
  assetId, jobId, schemeId, surfaceColorPlan, userIntent,
  taskType, parentRevisionId, sourcePath,
}) {
  const [result] = await pool.query(
    `INSERT INTO ai_visualizations
       (asset_id, job_id, scheme_id, task_type, parent_revision_id, source_path, surface_color_plan, user_intent, result_path, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 'pending')`,
    [
      assetId, jobId, schemeId || null, taskType || 'visualize_paint',
      parentRevisionId || null, sourcePath || null,
      JSON.stringify(surfaceColorPlan || []), userIntent || null,
    ]
  );
  return getVisualization(result.insertId);
}

// Most recent revision for an asset, regardless of task type or status —
// the "what should the next operation build on top of" chain-head. Callers
// that only want a usable source image should filter to status === 'ready'
// themselves (a 'pending'/'failed' revision has no result_path yet).
async function getLatestForAsset(assetId) {
  const [rows] = await pool.query(
    'SELECT * FROM ai_visualizations WHERE asset_id = ? ORDER BY id DESC LIMIT 1',
    [assetId]
  );
  return rows[0] ? decode(rows[0]) : null;
}

async function markReady(id, { resultPath, validation }) {
  await pool.query(
    `UPDATE ai_visualizations SET status = 'ready', result_path = ?, validation_json = ? WHERE id = ?`,
    [resultPath, validation ? JSON.stringify(validation) : null, id]
  );
  return getVisualization(id);
}

// failureReason is stored in the existing validation_json column (no schema
// change needed) so the frontend can show a real reason without a second
// round trip to ai_jobs — the row that actually failed is right here.
async function markFailed(id, failureReason) {
  await pool.query(
    `UPDATE ai_visualizations SET status = 'failed', validation_json = ? WHERE id = ?`,
    [failureReason ? JSON.stringify({ failureReason: String(failureReason).slice(0, 500) }) : null, id]
  );
  return getVisualization(id);
}

async function getVisualization(id) {
  const [rows] = await pool.query('SELECT * FROM ai_visualizations WHERE id = ?', [id]);
  return rows[0] ? decode(rows[0]) : null;
}

async function listForAsset(assetId) {
  const [rows] = await pool.query(
    'SELECT * FROM ai_visualizations WHERE asset_id = ? ORDER BY id DESC LIMIT 50',
    [assetId]
  );
  return rows.map(decode);
}

function decode(row) {
  return {
    ...row,
    surfaceColorPlan: parseJson(row.surface_color_plan),
    validationJson: parseJson(row.validation_json),
  };
}

function parseJson(v) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

module.exports = { createPending, markReady, markFailed, getVisualization, listForAsset, getLatestForAsset };
