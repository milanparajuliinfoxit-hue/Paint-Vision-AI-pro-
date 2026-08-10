const mysql = require('mysql2/promise');
require('dotenv').config();
const logger = require('../services/logger.service');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true,
});

// Idle-connection failures (server restart, network blip) are emitted on the
// underlying pool, not thrown at a query site — without a listener Node
// treats them as unhandled 'error' events and crashes the process.
pool.pool.on('error', (err) => {
  logger.error({ message: `MySQL pool error: ${err.message}`, code: err.code, fatal: err.fatal });
});

// Used by /health so an unreachable database is reported instead of the
// endpoint always answering "ok".
async function ping() {
  const conn = await pool.getConnection();
  try {
    await conn.ping();
  } finally {
    conn.release();
  }
}

module.exports = pool;
module.exports.ping = ping;
