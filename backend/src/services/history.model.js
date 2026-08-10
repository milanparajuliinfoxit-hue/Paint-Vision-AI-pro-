const pool = require('../config/db');
const { findById, listByColumn } = require('./db.helpers');

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
  return findById('history_entries', result.insertId);
}

function listForProject(projectId) {
  return listByColumn('history_entries', 'project_id', projectId, 'created_at ASC, id ASC');
}

module.exports = { appendEntry, listForProject };
