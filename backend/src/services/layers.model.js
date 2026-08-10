const pool = require('../config/db');

async function createLayer({ assetId, name, maskPath, createdVia, currentColorId, opacity, orderIndex, aiSurfaceKey }) {
  const [result] = await pool.query(
    `INSERT INTO layers (asset_id, name, mask_path, created_via, current_color_id, opacity, order_index, ai_surface_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [assetId, name, maskPath || null, createdVia, currentColorId || null, opacity ?? 1, orderIndex ?? 0, aiSurfaceKey || null]
  );
  return getLayer(result.insertId);
}

// Idempotent AI-surface layer apply. The (ai_analysis_id, ai_surface_key)
// unique index guarantees one layer per surface per analysis: re-applying a
// scheme or surface updates the existing row (color, scheme, order) in place —
// and revives it if the dealer had deleted it — instead of inserting
// duplicates. Returns { layer, created } so the controller can respond 201 vs
// 200 and the client can skip a redundant history entry.
async function upsertAiLayer({ assetId, name, maskPath, currentColorId, opacity, orderIndex, aiSurfaceKey, aiAnalysisId, aiSchemeId }) {
  const [result] = await pool.query(
    `INSERT INTO layers
       (asset_id, name, mask_path, created_via, current_color_id, opacity, order_index,
        ai_surface_key, ai_analysis_id, ai_scheme_id)
     VALUES (?, ?, ?, 'ai-surface', ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       current_color_id = VALUES(current_color_id),
       ai_scheme_id = VALUES(ai_scheme_id),
       order_index = VALUES(order_index),
       deleted_at = NULL,
       updated_at = NOW(3)`,
    [assetId, name, maskPath || null, currentColorId || null, opacity ?? 1, orderIndex ?? 0,
      aiSurfaceKey, aiAnalysisId || null, aiSchemeId || null]
  );

  const [rows] = await pool.query(
    `SELECT * FROM layers WHERE ai_analysis_id = ? AND ai_surface_key = ? LIMIT 1`,
    [aiAnalysisId, aiSurfaceKey]
  );
  return { layer: rows[0] || null, created: result.affectedRows === 1 };
}

async function getLayer(id) {
  const [rows] = await pool.query('SELECT * FROM layers WHERE id = ? AND deleted_at IS NULL', [id]);
  return rows[0] || null;
}

// Includes soft-deleted rows — only the restore flow needs to see a
// currently-deleted layer to bring it back.
async function getLayerIncludingDeleted(id) {
  const [rows] = await pool.query('SELECT * FROM layers WHERE id = ?', [id]);
  return rows[0] || null;
}

async function listLayersForAsset(assetId) {
  const [rows] = await pool.query(
    'SELECT * FROM layers WHERE asset_id = ? AND deleted_at IS NULL ORDER BY order_index ASC, id ASC',
    [assetId]
  );
  return rows;
}

// Includes soft-deleted layers — used when the whole asset is being
// hard-deleted, so a paint layer that's currently only soft-deleted (and
// therefore still has a real mask file on disk) doesn't get skipped and
// left orphaned.
async function listAllLayersForAsset(assetId) {
  const [rows] = await pool.query('SELECT * FROM layers WHERE asset_id = ?', [assetId]);
  return rows;
}

// API field name -> DB column.
const FIELD_MAP = {
  name: 'name',
  maskPath: 'mask_path',
  currentColorId: 'current_color_id',
  opacity: 'opacity',
  finishOverride: 'finish_override',
  aiSurfaceKey: 'ai_surface_key',
  orderIndex: 'order_index',
  locked: 'locked',
  visible: 'visible',
};

async function updateLayer(id, patch = {}, expectedUpdatedAt) {
  const current = await getLayer(id);
  if (!current) return null;

  if (expectedUpdatedAt) {
    const currentTs = new Date(current.updated_at).getTime();
    const expectedTs = new Date(expectedUpdatedAt).getTime();
    if (currentTs !== expectedTs) {
      const err = new Error('This layer was updated elsewhere — reload to see the latest.');
      err.status = 409;
      throw err;
    }
  }

  const keys = Object.keys(patch).filter((k) => FIELD_MAP[k]);
  if (keys.length === 0) return current;

  const setClause = keys.map((k) => `${FIELD_MAP[k]} = ?`).join(', ');
  const values = keys.map((k) => patch[k]);
  await pool.query(`UPDATE layers SET ${setClause} WHERE id = ?`, [...values, id]);
  return getLayer(id);
}

// Soft delete: keeps the row (and its on-disk mask file, untouched) so a
// later undo can restore it exactly instead of recreating a new row with a
// new id — the latter is what caused stale undo/redo commands to PATCH an
// id that no longer existed (404 Not Found).
async function deleteLayer(id) {
  await pool.query('UPDATE layers SET deleted_at = NOW(3) WHERE id = ? AND deleted_at IS NULL', [id]);
}

async function restoreLayer(id) {
  await pool.query('UPDATE layers SET deleted_at = NULL WHERE id = ?', [id]);
  return getLayer(id);
}

module.exports = {
  createLayer, upsertAiLayer, getLayer, getLayerIncludingDeleted, listLayersForAsset, listAllLayersForAsset,
  updateLayer, deleteLayer, restoreLayer,
};
