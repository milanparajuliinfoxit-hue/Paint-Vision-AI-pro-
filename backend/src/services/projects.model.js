const pool = require('../config/db');
const { selectOne, selectAll, buildSetClause, assertNotStale } = require('./db.helpers');
const { notFound } = require('../utils/httpError');

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

function getProject(id) {
  return selectOne(
    `SELECT projects.*, ${COVER_COLUMNS} FROM projects ${COVER_JOIN} WHERE projects.id = ?`,
    [id]
  );
}

// Every project-scoped route starts with the same existence check.
async function getProjectOrFail(id) {
  const project = await getProject(id);
  if (!project) throw notFound('Project not found');
  return project;
}

function listProjects({ search = '', status = null } = {}) {
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

  return selectAll(
    `SELECT projects.*, ${COVER_COLUMNS} FROM projects ${COVER_JOIN} ${where} ORDER BY projects.updated_at DESC`,
    params
  );
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

  assertNotStale(current, expectedUpdatedAt, 'project');

  const { keys, setClause, values } = buildSetClause(FIELD_MAP, patch, (key, value) =>
    (key === 'tags' ? JSON.stringify(value) : value)
  );
  if (keys.length === 0) return current;

  await pool.query(`UPDATE projects SET ${setClause} WHERE id = ?`, [...values, id]);
  return getProject(id);
}

module.exports = { createProject, getProject, getProjectOrFail, listProjects, updateProject };
