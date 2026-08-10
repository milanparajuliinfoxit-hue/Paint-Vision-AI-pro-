const pool = require('../config/db');
const { findById, listByColumn } = require('./db.helpers');

async function createConcept({ projectId, name, thumbnailPath, layerColorMap }) {
  const [result] = await pool.query(
    'INSERT INTO concepts (project_id, name, thumbnail_path, layer_color_map) VALUES (?, ?, ?, ?)',
    [projectId, name, thumbnailPath || null, layerColorMap !== undefined ? JSON.stringify(layerColorMap) : null]
  );
  return findById('concepts', result.insertId);
}

function listForProject(projectId) {
  return listByColumn('concepts', 'project_id', projectId, 'created_at DESC');
}

module.exports = { createConcept, listForProject };
