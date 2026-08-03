const pool = require('../config/db');

async function appendEntry({ projectId, action, beforeState, afterState }) {
  const [result] = await pool.query(
    'INSERT INTO history_entries (project_id, action, before_state, after_state) VALUES (?, ?, ?, ?)',
    [
      projectId,
      action,
      beforeState !== undefined ? JSON.stringify(beforeState) : null,
      afterState !== undefined ? JSON.stringify(afterState) : null,
    ]
  );
  const [rows] = await pool.query('SELECT * FROM history_entries WHERE id = ?', [result.insertId]);
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
