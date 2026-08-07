/* Reconciles on-disk upload folders with the assets table.
 *
 * The uploads folder holds the bytes; the assets table decides what the app
 * shows. If the database is re-initialised (npm run migrate) while files
 * survive on disk, asset rows are lost and photos silently disappear from the
 * editor even though the files still exist.
 *
 * Usage (run from backend/):
 *   npm run reconcile                 # dry run — list orphans only
 *   npm run reconcile -- --project 3  # re-link orphans into project 3
 *
 * Re-linking reuses the on-disk folder UUID as the asset id, so the stored
 * original_path/cleaned_path keep pointing at the exact files already there —
 * no copying, no path rewriting, and it works for every project.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const storage = require('../services/storage.service');
const pool = require('../config/db');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readProjectArg(argv) {
  const idx = argv.indexOf('--project');
  if (idx !== -1 && argv[idx + 1]) return Number(argv[idx + 1]);
  const inline = argv.find((a) => a.startsWith('--project='));
  if (inline) return Number(inline.split('=')[1]);
  return null;
}

async function main() {
  const targetProjectId = readProjectArg(process.argv.slice(2));
  const root = storage.UPLOAD_ROOT;

  // Asset folders normally live directly under the upload root
  // ('<root>/<assetId>/original.jpg'), but older uploads were written one
  // level deeper ('<root>/uploads/<assetId>/...') before that extra nesting
  // was removed — walk depth ≤ 2 generically so both layouts reconcile.
  const folders = [];
  const scanDir = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (UUID_RE.test(e.name)) {
        folders.push(full);
        continue;
      }
      // One more level down, but never recurse into stray nested trees.
      for (const inner of fs.readdirSync(full, { withFileTypes: true })) {
        if (inner.isDirectory() && UUID_RE.test(inner.name)) folders.push(path.join(full, inner.name));
      }
    }
  };
  scanDir(root);

  const [rows] = await pool.query('SELECT id FROM assets');
  const knownIds = new Set(rows.map((r) => r.id));

  const orphans = [];
  for (const folder of folders) {
    const id = path.basename(folder);
    if (knownIds.has(id)) continue;
    const rel = path.relative(root, folder);
    const original = path.join(rel, 'original.jpg');
    if (!(await storage.exists(original))) continue; // folder without a usable original
    const cleaned = path.join(rel, 'cleaned.jpg');
    orphans.push({
      id,
      originalPath: original,
      cleanedPath: (await storage.exists(cleaned)) ? cleaned : null,
    });
  }

  console.log(`Scanned ${folders.length} upload folder(s); ${knownIds.size} known asset(s).`);
  if (orphans.length === 0) {
    console.log('No orphaned uploads found — nothing to do.');
    await pool.end();
    return;
  }

  console.log(`Found ${orphans.length} orphaned upload(s):`);
  orphans.forEach((o) => console.log(`  - ${o.id}${o.cleanedPath ? '  (also has cleaned.jpg)' : ''}`));

  if (!targetProjectId) {
    console.log('\nDry run — nothing changed. Re-link them with: npm run reconcile -- --project <projectId>');
    await pool.end();
    return;
  }

  const [projects] = await pool.query('SELECT id, name, client_name FROM projects WHERE id = ?', [targetProjectId]);
  if (projects.length === 0) {
    console.error(`Project ${targetProjectId} does not exist.`);
    process.exitCode = 1;
    await pool.end();
    return;
  }

  console.log(`Linking ${orphans.length} orphaned upload(s) into project ${targetProjectId} (${projects[0].name || projects[0].client_name})…`);
  for (const o of orphans) {
    const status = o.cleanedPath ? 'cleaned' : 'uploaded';
    await pool.query(
      `INSERT INTO assets (id, project_id, original_path, cleaned_path, status)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         project_id = VALUES(project_id),
         original_path = VALUES(original_path),
         cleaned_path = VALUES(cleaned_path),
         status = VALUES(status)`,
      [o.id, targetProjectId, o.originalPath, o.cleanedPath, status]
    );
    console.log(`  linked ${o.id} (status: ${status})`);
  }

  await pool.end();
  console.log('Done. Refresh the project in the editor to see the photos.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
