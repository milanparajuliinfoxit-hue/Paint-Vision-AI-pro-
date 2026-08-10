const pool = require('../config/db');

async function createProject({ name, clientName, referenceNote, tags } = {}) {
  const [result] = await pool.query(
    'INSERT INTO projects (name, client_name, reference_note, tags) VALUES (?, ?, ?, ?)',
    [name || null, clientName || null, referenceNote || null, tags ? JSON.stringify(tags) : null]
  );
  return getProject(result.insertId);
}

// Joins in the cover asset's image paths so list/detail cards can render a
// thumbnail in one request instead of the frontend re-fetching each
// project's assets just to find a preview image.
const COVER_JOIN = `
  LEFT JOIN assets cover ON cover.id = projects.cover_asset_id
`;
const COVER_COLUMNS = 'cover.original_path AS cover_original_path, cover.cleaned_path AS cover_cleaned_path';

async function getProject(id) {
  const [rows] = await pool.query(
    `SELECT projects.*, ${COVER_COLUMNS} FROM projects ${COVER_JOIN} WHERE projects.id = ?`,
    [id]
  );
  return rows[0] || null;
}

async function listProjects({ search = '', status = null } = {}) {
  const params = [];
  let where = 'WHERE 1=1';

  if (search) {
    where += ' AND (projects.name LIKE ? OR projects.client_name LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  if (status) {
    where += ' AND projects.status = ?';
    params.push(status);
  }

  const [rows] = await pool.query(
    `SELECT projects.*, ${COVER_COLUMNS} FROM projects ${COVER_JOIN} ${where} ORDER BY projects.updated_at DESC`,
    params
  );
  return rows;
}

// API field name -> DB column, so PATCH bodies can stay camelCase.
const FIELD_MAP = {
  name: 'name',
  clientName: 'client_name',
  referenceNote: 'reference_note',
  status: 'status',
  coverAssetId: 'cover_asset_id',
  tags: 'tags',
};

async function updateProject(id, patch = {}, expectedUpdatedAt) {
  const current = await getProject(id);
  if (!current) return null;

  // Last-write-wins is acceptable for single-editor scope, but surface a
  // conflict instead of silently overwriting (requirements doc, Section 7).
  if (expectedUpdatedAt) {
    const currentTs = new Date(current.updated_at).getTime();
    const expectedTs = new Date(expectedUpdatedAt).getTime();
    if (currentTs !== expectedTs) {
      const err = new Error('This project was updated elsewhere — reload to see the latest.');
      err.status = 409;
      throw err;
    }
  }

  const keys = Object.keys(patch).filter((k) => FIELD_MAP[k]);
  if (keys.length === 0) return current;

  const setClause = keys.map((k) => `${FIELD_MAP[k]} = ?`).join(', ');
  const values = keys.map((k) => (k === 'tags' ? JSON.stringify(patch[k]) : patch[k]));
  await pool.query(`UPDATE projects SET ${setClause} WHERE id = ?`, [...values, id]);
  return getProject(id);
}

// Separate from updateProject/FIELD_MAP on purpose: undo/redo/jump can fire
// several times a second while a dealer scrubs the History tab, and running
// that through the optimistic-concurrency PATCH (Section 7) would either
// force the client to refetch updated_at between every keystroke or throw
// spurious 409s. This is a best-effort UI bookmark, not authoritative layer
// state (the layer mutations undo/redo actually perform are what's
// authoritative) — last-write-wins is fine. `updated_at = updated_at`
// explicitly re-asserts the current value so the ON UPDATE CURRENT_TIMESTAMP
// trigger doesn't fire and desync the real PATCH endpoint's conflict check.
async function setUndoPointer(id, pointer) {
  await pool.query('UPDATE projects SET undo_pointer = ?, updated_at = updated_at WHERE id = ?', [pointer, id]);
  return getProject(id);
}

// Deleting a project is one transaction because assets.project_id is ON
// DELETE SET NULL (schema.sql): dropping just the project row would orphan
// every photo, and layers/ai_jobs/detected_*/paint_recommendations all
// cascade off the asset rows. So assets go first, then the project row —
// history_entries/concepts/export_jobs/paint_recommendations CASCADE off
// the project row itself. Disk cleanup is the route's job (same split as
// assets.controller.js's deleteAsset).
async function deleteProject(id) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query('DELETE FROM assets WHERE project_id = ?', [id]);
    const [result] = await connection.query('DELETE FROM projects WHERE id = ?', [id]);
    await connection.commit();
    return result.affectedRows > 0;
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

module.exports = { createProject, getProject, listProjects, updateProject, setUndoPointer, deleteProject };
