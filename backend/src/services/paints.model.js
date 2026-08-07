const pool = require('../config/db');

const PRODUCT_LINE_FIELDS = [
  'tenprotect', 'brightshine', 'colorfuleco', 'jotashield',
  'majestic', 'sevenprotect', 'surprised',
];

async function list({ search = '', productLine = null, page = 1, pageSize = 25 }) {
  const offset = (page - 1) * pageSize;
  const params = [];
  let where = 'WHERE is_deleted = 0';

  if (search) {
    where += ' AND (color_name LIKE ? OR color_code LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  if (productLine && PRODUCT_LINE_FIELDS.includes(productLine)) {
    where += ` AND ${productLine} = 1`;
  }

  const [rows] = await pool.query(
    `SELECT * FROM paints ${where} ORDER BY color_name ASC LIMIT ? OFFSET ?`,
    [...params, Number(pageSize), Number(offset)]
  );
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM paints ${where}`,
    params
  );

  return { rows, total, page: Number(page), pageSize: Number(pageSize) };
}

// `executor` defaults to the shared pool (autocommit, one-off connection)
// but every call site inside a transaction (excelImport.service.js
// commitImport) passes its transaction connection instead, so writes made
// mid-import actually roll back together on failure. Previously these three
// functions always used `pool` regardless of caller, which silently
// defeated commitImport's beginTransaction/commit/rollback — only the
// import_log row was ever transactional.
async function getById(id, executor = pool) {
  const [rows] = await executor.query(
    'SELECT * FROM paints WHERE id = ? AND is_deleted = 0',
    [id]
  );
  return rows[0] || null;
}

async function create(data, executor = pool) {
  const cols = [
    's_id', 'color_code', 'color_name',
    ...PRODUCT_LINE_FIELDS,
    'r_value', 'g_value', 'b_value',
  ];
  const values = cols.map((c) => toColumnValue(data, c));
  const [result] = await executor.query(
    `INSERT INTO paints (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    values
  );
  return getById(result.insertId, executor);
}

async function update(id, data, executor = pool) {
  const cols = [
    'color_code', 'color_name',
    ...PRODUCT_LINE_FIELDS,
    'r_value', 'g_value', 'b_value',
  ];
  const setClause = cols.map((c) => `${c} = ?`).join(', ');
  const values = cols.map((c) => toColumnValue(data, c));
  // is_deleted=0 unconditionally: update() is only ever called to make a row
  // live (admin edit, or an Excel re-import reviving a previously-deleted
  // color) — see findByColorCode's includeDeleted option below, which is
  // what lets a re-import revive instead of crashing on the color_code
  // unique constraint.
  await executor.query(`UPDATE paints SET ${setClause}, is_deleted = 0 WHERE id = ?`, [...values, id]);
  return getById(id, executor);
}

async function softDelete(id) {
  await pool.query('UPDATE paints SET is_deleted = 1 WHERE id = ?', [id]);
}

// Used by Excel import — matches on color_code. includeDeleted:true also
// matches a soft-deleted row, so a re-import of a previously-deleted color
// classifies as 'update' (which revives it, see update() above) instead of
// 'create', which would otherwise crash on the color_code unique constraint.
async function findByColorCode(colorCode, { includeDeleted = false } = {}) {
  const where = includeDeleted ? 'WHERE color_code = ?' : 'WHERE color_code = ? AND is_deleted = 0';
  const [rows] = await pool.query(`SELECT * FROM paints ${where}`, [colorCode]);
  return rows[0] || null;
}

function toColumnValue(data, col) {
  if (PRODUCT_LINE_FIELDS.includes(col)) return data[col] ? 1 : 0;
  return data[col] ?? null;
}

module.exports = {
  PRODUCT_LINE_FIELDS,
  list,
  getById,
  create,
  update,
  softDelete,
  findByColorCode,
};
