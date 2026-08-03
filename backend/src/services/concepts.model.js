const pool = require('../config/db');

async function createConcept({ projectId, name, thumbnailPath, layerColorMap }) {
  const [result] = await pool.query(
    'INSERT INTO concepts (project_id, name, thumbnail_path, layer_color_map) VALUES (?, ?, ?, ?)',
    [projectId, name, thumbnailPath || null, layerColorMap !== undefined ? JSON.stringify(layerColorMap) : null]
  );
  const [rows] = await pool.query('SELECT * FROM concepts WHERE id = ?', [result.insertId]);
  return rows[0];
}

async function listForProject(projectId) {
  const [rows] = await pool.query(
    'SELECT * FROM concepts WHERE project_id = ? ORDER BY created_at DESC',
    [projectId]
  );
  return rows;
}

module.exports = { createConcept, listForProject };
