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
    "ALTER TABLE ai_jobs ADD COLUMN running_claim VARCHAR(30) GENERATED ALWAYS AS (CASE WHEN status = 'running' THEN job_type ELSE NULL END) STORED",
  ];
  for (const stmt of upgradeColumns) {
    try {
      await connection.query(stmt);
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
  }

  // undo_pointer backfill only belongs in the same run that adds the
  // column. A project's pointer reflects real undo/redo activity from then
  // on, so re-running this UPDATE on every `npm run migrate` would clobber
  // legitimate state with "everything in the log is applied" — wrong for
  // any project with an actual undo in progress. Gating it on the ALTER
  // succeeding (not hitting ER_DUP_FIELDNAME) makes it run exactly once.
  try {
    await connection.query('ALTER TABLE projects ADD COLUMN undo_pointer INT NOT NULL DEFAULT -1');
    await connection.query(`
      UPDATE projects p
      LEFT JOIN (SELECT project_id, COUNT(*) AS cnt FROM history_entries GROUP BY project_id) h
        ON h.project_id = p.id
      SET p.undo_pointer = COALESCE(h.cnt, 0) - 1
    `);
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') throw err;
  }

  // Separate loop for indexes: re-running an ADD INDEX/ADD UNIQUE KEY fails
  // with ER_DUP_KEYNAME, not ER_DUP_FIELDNAME — a statement that adds an
  // index was previously mixed into the column loop above, which meant
  // `npm run migrate` actually threw on its second run despite being
  // documented as safe to re-run (found by actually re-running it, not by
  // reading the code). `uq_layers_ai_surface`'s ADD COLUMN statements for
  // ai_analysis_id/ai_surface_key stay above since those are genuinely
  // column adds; only the index statement moved here.
  const upgradeIndexes = [
    'ALTER TABLE layers ADD UNIQUE INDEX uq_layers_ai_surface (ai_analysis_id, ai_surface_key)',
    'ALTER TABLE ai_jobs ADD UNIQUE KEY uq_ai_jobs_running (asset_id, running_claim)',
  ];
  for (const stmt of upgradeIndexes) {
    try {
      await connection.query(stmt);
    } catch (err) {
      if (err.code !== 'ER_DUP_KEYNAME') throw err;
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
