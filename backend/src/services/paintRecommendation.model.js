/**
 * Data layer for persisted paint recommendations (schemes).
 */
const pool = require('../config/db');

async function createScheme({ projectId, assetId, schemeName, tagline, rationale, schemeJson }) {
  const [result] = await pool.query(
    `INSERT INTO paint_recommendations (project_id, asset_id, scheme_name, tagline, rationale, scheme_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [projectId, assetId, schemeName, tagline || null,
      rationale ? JSON.stringify(rationale) : null,
      JSON.stringify(schemeJson)]
  );
  return getScheme(result.insertId);
}

async function getScheme(id) {
  const [rows] = await pool.query('SELECT * FROM paint_recommendations WHERE id = ?', [id]);
  return rows[0] ? decodeScheme(rows[0]) : null;
}

async function listForAsset(assetId) {
  const [rows] = await pool.query(
    'SELECT * FROM paint_recommendations WHERE asset_id = ? ORDER BY id DESC',
    [assetId]
  );
  return rows.map(decodeScheme);
}

// Re-running "generate" creates a fresh batch; keep the UI tidy by removing
// the previous batch for the same asset.
async function clearForAsset(assetId) {
  await pool.query('DELETE FROM paint_recommendations WHERE asset_id = ?', [assetId]);
}

function decodeScheme(row) {
  return {
    ...row,
    rationale: parseJson(row.rationale),
    schemeJson: parseJson(row.scheme_json),
  };
}

function parseJson(v) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

module.exports = { createScheme, getScheme, listForAsset, clearForAsset };
