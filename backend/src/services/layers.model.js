const pool = require('../config/db');
const { selectOne, selectAll, findById, listByColumn, buildSetClause, assertNotStale } = require('./db.helpers');

async function createLayer({ assetId, name, maskPath, createdVia, currentColorId, opacity, orderIndex }) {
  const [result] = await pool.query(
    `INSERT INTO layers (asset_id, name, mask_path, created_via, current_color_id, opacity, order_index)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [assetId, name, maskPath || null, createdVia, currentColorId || null, opacity ?? 1, orderIndex ?? 0]
  );
  return getLayer(result.insertId);
}

function getLayer(id) {
  return selectOne('SELECT * FROM layers WHERE id = ? AND deleted_at IS NULL', [id]);
}

// Includes soft-deleted rows — only the restore flow needs to see a
// currently-deleted layer to bring it back.
function getLayerIncludingDeleted(id) {
  return findById('layers', id);
}

function listLayersForAsset(assetId) {
  return selectAll(
    'SELECT * FROM layers WHERE asset_id = ? AND deleted_at IS NULL ORDER BY order_index ASC, id ASC',
    [assetId]
  );
}

// Includes soft-deleted layers — used when the whole asset is being
// hard-deleted, so a paint layer that's currently only soft-deleted (and
// therefore still has a real mask file on disk) doesn't get skipped and
// left orphaned.
function listAllLayersForAsset(assetId) {
  return listByColumn('layers', 'asset_id', assetId);
}

// API field name -> DB column.
const FIELD_MAP = {
  name: 'name',
  maskPath: 'mask_path',
  currentColorId: 'current_color_id',
  opacity: 'opacity',
  finishOverride: 'finish_override',
  orderIndex: 'order_index',
  locked: 'locked',
  visible: 'visible',
};

async function updateLayer(id, patch = {}, expectedUpdatedAt) {
  const current = await getLayer(id);
  if (!current) return null;

  assertNotStale(current, expectedUpdatedAt, 'layer');

  const { keys, setClause, values } = buildSetClause(FIELD_MAP, patch);
  if (keys.length === 0) return current;

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
  createLayer, getLayer, getLayerIncludingDeleted, listLayersForAsset, listAllLayersForAsset,
  updateLayer, deleteLayer, restoreLayer,
};
