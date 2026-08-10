const pool = require('../config/db');
const { conflict } = require('../utils/httpError');

// mysql2 always returns [rows, fields]; every model unwrapped that by hand.
async function selectAll(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function selectOne(sql, params = []) {
  const rows = await selectAll(sql, params);
  return rows[0] || null;
}

function findById(table, id) {
  return selectOne(`SELECT * FROM ${table} WHERE id = ?`, [id]);
}

function listByColumn(table, column, value, orderBy) {
  return selectAll(
    `SELECT * FROM ${table} WHERE ${column} = ?${orderBy ? ` ORDER BY ${orderBy}` : ''}`,
    [value]
  );
}

/**
 * Turns a camelCase API patch into a `col = ?` clause plus its values, using
 * the model's own API-field -> DB-column map. Unknown fields are dropped, so
 * a PATCH body can't reach columns the model didn't opt in to.
 */
function buildSetClause(fieldMap, patch = {}, toValue = (key, value) => value) {
  const keys = Object.keys(patch).filter((key) => fieldMap[key]);
  return {
    keys,
    setClause: keys.map((key) => `${fieldMap[key]} = ?`).join(', '),
    values: keys.map((key) => toValue(key, patch[key])),
  };
}

/**
 * Last-write-wins is acceptable for single-editor scope, but surface a
 * conflict instead of silently overwriting (requirements doc, Section 7).
 */
function assertNotStale(current, expectedUpdatedAt, label) {
  if (!expectedUpdatedAt) return;
  const currentTs = new Date(current.updated_at).getTime();
  const expectedTs = new Date(expectedUpdatedAt).getTime();
  if (currentTs !== expectedTs) {
    throw conflict(`This ${label} was updated elsewhere — reload to see the latest.`);
  }
}

module.exports = { selectAll, selectOne, findById, listByColumn, buildSetClause, assertNotStale };
