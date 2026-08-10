const pool = require('../config/db');
const { selectOne, selectAll } = require('./db.helpers');

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

  const rows = await selectAll(
    `SELECT * FROM paints ${where} ORDER BY color_name ASC LIMIT ? OFFSET ?`,
    [...params, Number(pageSize), Number(offset)]
  );
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM paints ${where}`,
    params
  );

  return { rows, total, page: Number(page), pageSize: Number(pageSize) };
}

function getById(id) {
  return selectOne('SELECT * FROM paints WHERE id = ? AND is_deleted = 0', [id]);
}

async function create(data) {
  const cols = [
    's_id', 'color_code', 'color_name',
    ...PRODUCT_LINE_FIELDS,
    'r_value', 'g_value', 'b_value',
  ];
  const values = cols.map((c) => toColumnValue(data, c));
  const [result] = await pool.query(
    `INSERT INTO paints (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    values
  );
  return getById(result.insertId);
}

async function update(id, data) {
  const cols = [
    'color_code', 'color_name',
    ...PRODUCT_LINE_FIELDS,
    'r_value', 'g_value', 'b_value',
  ];
  const setClause = cols.map((c) => `${c} = ?`).join(', ');
  const values = cols.map((c) => toColumnValue(data, c));
  await pool.query(`UPDATE paints SET ${setClause} WHERE id = ?`, [...values, id]);
  return getById(id);
}

async function softDelete(id) {
  await pool.query('UPDATE paints SET is_deleted = 1 WHERE id = ?', [id]);
}

// Used by Excel import — matches on color_code.
function findByColorCode(colorCode) {
  return selectOne('SELECT * FROM paints WHERE color_code = ? AND is_deleted = 0', [colorCode]);
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
