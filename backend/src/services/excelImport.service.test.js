const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../config/db');
const { commitImport } = require('./excelImport.service');

// Hits the real dev database — same reasoning as aiJobs.model.test.js.
let dbAvailable = true;
test.before(async () => {
  try { await pool.query('SELECT 1'); } catch { dbAvailable = false; }
});
test.after(async () => { await pool.end().catch(() => {}); });

function row(colorCode, overrides = {}) {
  return {
    action: 'create',
    data: { s_id: null, color_code: colorCode, color_name: 'Regression test', r_value: 1, g_value: 2, b_value: 3, ...overrides },
  };
}

// Regression test for a real bug found live: paints.model.js's
// create/update previously always used the shared pool, not the
// transaction's connection, so commitImport's beginTransaction/commit/
// rollback only ever actually wrapped the import_log row — a mid-batch
// failure left every paint insert before it permanently committed. Fixed
// by threading the transaction connection through (see paints.model.js).
test('a failing batch (in-file duplicate color_code) leaves the catalog completely unchanged — real transactional rollback', async (t) => {
  if (!dbAvailable) return t.skip('no database reachable in this environment');

  const code = `TEST-ROLLBACK-${Date.now()}`;
  const [[before]] = await pool.query('SELECT COUNT(*) AS n FROM paints');

  await assert.rejects(
    () => commitImport({
      validRows: [row(code), row(code)], // same color_code twice -> 2nd insert hits uq_color_code
      fileName: 'test.xlsx',
      duplicateStrategy: 'create_new',
    }),
    (err) => {
      // Also a regression check: this used to leak the raw MySQL message
      // ("Duplicate entry 'X' for key 'paints.uq_color_code'") to the API.
      assert.equal(err.status, 409);
      assert.doesNotMatch(err.message, /uq_color_code|SQL|ER_DUP_ENTRY/i);
      return true;
    }
  );

  const [[after]] = await pool.query('SELECT COUNT(*) AS n FROM paints');
  assert.equal(after.n, before.n, 'catalog row count must be unchanged after a rolled-back import');

  const [rows] = await pool.query('SELECT id FROM paints WHERE color_code = ?', [code]);
  assert.equal(rows.length, 0, 'neither row from the failed batch should exist');
});

test('a clean batch with no conflicts commits normally (sanity check the transaction path is not broken)', async (t) => {
  if (!dbAvailable) return t.skip('no database reachable in this environment');

  const code = `TEST-COMMIT-${Date.now()}`;
  const result = await commitImport({
    validRows: [row(code)],
    fileName: 'test.xlsx',
    duplicateStrategy: 'create_new',
  });
  assert.equal(result.created, 1);

  const [rows] = await pool.query('SELECT id FROM paints WHERE color_code = ?', [code]);
  assert.equal(rows.length, 1);
  await pool.query('DELETE FROM paints WHERE color_code = ?', [code]); // cleanup
});
