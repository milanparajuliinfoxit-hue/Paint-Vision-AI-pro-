const pool = require('../config/db');

// `supersedeIds` (optional): history-entry ids the client's local undo stack
// just discarded because a new command was pushed after an undo (the
// abandoned redo tail — see LAYER_MASK_HISTORY_AUDIT.md §G.1/I for the full
// rationale, and hydrateHistory's filter in useHistoryCommand.js for the
// read side). Marking + appending happen in one transaction so a reload
// between the two can never observe a new entry without its supersede
// having landed (or vice versa). Rows are only ever marked, never deleted —
// mask files and the history rows describing them stay on disk/DB forever,
// exactly as before this change.
async function appendEntry({ projectId, action, beforeState, afterState, supersedeIds }) {
  const ids = Array.isArray(supersedeIds) ? supersedeIds.filter((id) => Number.isInteger(id)) : [];
  if (!ids.length) {
    return insertEntry(pool, { projectId, action, beforeState, afterState });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    // Scoped to project_id so a caller can never mark another project's
    // rows, and to `superseded_at IS NULL` so re-sending the same
    // supersedeIds (e.g. a retried request) is a harmless no-op, not a
    // second timestamp overwrite.
    await connection.query(
      'UPDATE history_entries SET superseded_at = NOW(3) WHERE project_id = ? AND id IN (?) AND superseded_at IS NULL',
      [projectId, ids]
    );
    const entry = await insertEntry(connection, { projectId, action, beforeState, afterState });
    await connection.commit();
    return entry;
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

async function insertEntry(runner, { projectId, action, beforeState, afterState }) {
  const [result] = await runner.query(
    'INSERT INTO history_entries (project_id, action, before_state, after_state) VALUES (?, ?, ?, ?)',
    [
      projectId,
      action,
      beforeState !== undefined ? JSON.stringify(beforeState) : null,
      afterState !== undefined ? JSON.stringify(afterState) : null,
    ]
  );
  const [rows] = await runner.query('SELECT * FROM history_entries WHERE id = ?', [result.insertId]);
  return rows[0];
}

async function listForProject(projectId) {
  const [rows] = await pool.query(
    'SELECT * FROM history_entries WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId]
  );
  return rows;
}

module.exports = { appendEntry, listForProject };
