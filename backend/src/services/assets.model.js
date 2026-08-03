const pool = require('../config/db');
const { v4: uuidv4 } = require('uuid');

async function createAsset({ projectId, originalPath, width, height, exifOrientation }) {
  const id = uuidv4();
  await pool.query(
    `INSERT INTO assets (id, project_id, original_path, width, height, exif_orientation, status)
     VALUES (?, ?, ?, ?, ?, ?, 'uploaded')`,
    [id, projectId || null, originalPath, width || null, height || null, exifOrientation || null]
  );
  return getAsset(id);
}

async function getAsset(id) {
  const [rows] = await pool.query('SELECT * FROM assets WHERE id = ?', [id]);
  return rows[0] || null;
}

async function listAssetsForProject(projectId) {
  const [rows] = await pool.query(
    'SELECT * FROM assets WHERE project_id = ? ORDER BY created_at ASC',
    [projectId]
  );
  return rows;
}

async function updateAssetOriginalPath(id, originalPath) {
  await pool.query('UPDATE assets SET original_path = ? WHERE id = ?', [originalPath, id]);
  return getAsset(id);
}

async function updateAssetStatus(id, { status, cleanedPath, errorMessage } = {}) {
  await pool.query(
    'UPDATE assets SET status = ?, cleaned_path = COALESCE(?, cleaned_path), error_message = ? WHERE id = ?',
    [status, cleanedPath || null, errorMessage || null, id]
  );
  return getAsset(id);
}

async function renameAsset(id, label) {
  await pool.query('UPDATE assets SET label = ? WHERE id = ?', [label, id]);
  return getAsset(id);
}

async function deleteAsset(id) {
  // Layer rows (and their mask files, cleaned up separately by the caller)
  // cascade via fk_layer_asset ON DELETE CASCADE.
  await pool.query('DELETE FROM assets WHERE id = ?', [id]);
}

async function insertDuplicate({ id, projectId, label, originalPath, cleanedPath, status }) {
  await pool.query(
    `INSERT INTO assets (id, project_id, label, original_path, cleaned_path, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, projectId, label, originalPath, cleanedPath, status]
  );
  return getAsset(id);
}

module.exports = {
  createAsset, getAsset, listAssetsForProject,
  updateAssetOriginalPath, updateAssetStatus,
  renameAsset, deleteAsset, insertDuplicate,
};
