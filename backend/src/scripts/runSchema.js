/* Runs schema.sql against MySQL. Usage: npm run migrate */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

async function main() {
  const dbName = process.env.DB_NAME || 'paint_visualizer';
  let sql = fs.readFileSync(path.join(__dirname, '../sql/schema.sql'), 'utf8');
  sql = sql.replace(/paint_visualizer/g, dbName);
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: true,
  });

  console.log('Applying schema.sql ...');
  await connection.query(sql);

  // Upgrade path for a DB that already ran an earlier version of schema.sql
  // (this MySQL version rejects `ADD COLUMN IF NOT EXISTS`, so do it
  // defensively in JS instead of relying on that SQL syntax).
  const upgradeColumns = [
    "ALTER TABLE projects ADD COLUMN name VARCHAR(150) NULL AFTER client_name",
    "ALTER TABLE projects ADD COLUMN status ENUM('draft','in_review','client_approved','archived') NOT NULL DEFAULT 'draft'",
    "ALTER TABLE projects ADD COLUMN cover_asset_id VARCHAR(36) NULL",
    "ALTER TABLE projects ADD COLUMN tags JSON NULL",
    "ALTER TABLE assets ADD COLUMN label VARCHAR(150) NULL AFTER project_id",
    "ALTER TABLE layers ADD COLUMN deleted_at TIMESTAMP(3) NULL",
    "ALTER TABLE layers ADD COLUMN ai_surface_key VARCHAR(80) NULL AFTER finish_override",
    "ALTER TABLE layers ADD COLUMN ai_analysis_id INT NULL AFTER ai_surface_key",
    "ALTER TABLE layers ADD COLUMN ai_scheme_id INT NULL AFTER ai_analysis_id",
    "ALTER TABLE layers ADD UNIQUE INDEX uq_layers_ai_surface (ai_analysis_id, ai_surface_key)",
  ];
  for (const stmt of upgradeColumns) {
    try {
      await connection.query(stmt);
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
  }

  // MODIFY is idempotent (re-running against a column already at this
  // precision is a no-op, not an error) — upgrades an earlier migrate run
  // that created updated_at at second resolution.
  const millisecondPrecision = [
    'projects', 'assets', 'layers', 'export_jobs',
  ].map((table) => `ALTER TABLE ${table} MODIFY updated_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`);
  for (const stmt of millisecondPrecision) {
    await connection.query(stmt);
  }

  console.log('Done.');
  await connection.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
