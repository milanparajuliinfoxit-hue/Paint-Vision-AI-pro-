const XLSX = require('xlsx');
const pool = require('../config/db');
const paintsModel = require('../services/paints.model');
const { paintSchema, EXCEL_COLUMN_MAP } = require('./paints.validation');

/**
 * Reads the uploaded workbook and returns a validation/diff report WITHOUT
 * writing to the database. The frontend shows this to the user, who then
 * calls /commit with the same rows + a duplicate strategy.
 */
async function previewImport(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: null });

  const report = { totalRows: rawRows.length, valid: [], errors: [] };

  for (let i = 0; i < rawRows.length; i++) {
    const rawRow = rawRows[i];
    const rowNum = i + 2; // account for header row, 1-indexed sheet rows
    const mapped = mapRow(rawRow);

    const parsed = paintSchema.safeParse(mapped);
    if (!parsed.success) {
      report.errors.push({
        row: rowNum,
        raw: rawRow,
        issues: parsed.error.issues.map((iss) => `${iss.path.join('.')}: ${iss.message}`),
      });
      continue;
    }

    // includeDeleted so a re-import of a previously soft-deleted color is
    // classified as 'update' (which revives it) rather than 'create', which
    // would otherwise hit the color_code unique constraint mid-commit.
    const existing = await paintsModel.findByColorCode(parsed.data.color_code, { includeDeleted: true });
    report.valid.push({
      row: rowNum,
      data: parsed.data,
      action: existing ? 'update' : 'create',
      existingId: existing ? existing.id : null,
      revives: !!(existing && existing.is_deleted),
    });
  }

  report.summary = {
    willCreate: report.valid.filter((r) => r.action === 'create').length,
    willUpdate: report.valid.filter((r) => r.action === 'update').length,
    errorCount: report.errors.length,
  };

  return report;
}

/**
 * Commits a previously-previewed set of valid rows.
 * duplicateStrategy: 'update' (default) | 'skip' | 'create_new'
 */
async function commitImport({ validRows, fileName, duplicateStrategy = 'update' }) {
  const conn = await pool.getConnection();
  let created = 0;
  let updated = 0;
  let skipped = 0;

  try {
    await conn.beginTransaction();

    for (const row of validRows) {
      if (row.action === 'update') {
        if (duplicateStrategy === 'skip') {
          skipped++;
          continue;
        }
        if (duplicateStrategy === 'create_new') {
          await paintsModel.create(row.data, conn);
          created++;
          continue;
        }
        await paintsModel.update(row.existingId, row.data, conn);
        updated++;
      } else {
        await paintsModel.create(row.data, conn);
        created++;
      }
    }

    await conn.query(
      `INSERT INTO import_log (file_name, rows_new, rows_updated, rows_skipped, rows_error)
       VALUES (?, ?, ?, ?, ?)`,
      [fileName, created, updated, skipped, 0]
    );

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    // Found by actually running an import with an in-batch duplicate SKU
    // (two rows sharing a color_code, both classified 'create' since
    // neither exists yet — preview can't see the batch's own duplicates):
    // the raw MySQL constraint message ("Duplicate entry 'X' for key
    // 'paints.uq_color_code'") was reaching the API response unfiltered.
    // The whole batch is already correctly rolled back above; this only
    // changes what the dealer sees about why.
    if (err.code === 'ER_DUP_ENTRY') {
      const clean = new Error('Import failed — the file has more than one row with the same color code. Fix the duplicate and re-import; nothing was changed.');
      clean.status = 409;
      throw clean;
    }
    throw err;
  } finally {
    conn.release();
  }

  return { created, updated, skipped };
}

function exportToBuffer(paints) {
  const rows = paints.map((p) => ({
    id: p.id,
    s_id: p.s_id,
    colorCode: p.color_code,
    colorName: p.color_name,
    tenprotect: p.tenprotect,
    brightshine: p.brightshine,
    colorfuleco: p.colorfuleco,
    jotashield: p.jotashield,
    majestic: p.majestic,
    sevenprotect: p.sevenprotect,
    surprised: p.surprised,
    rValue: p.r_value,
    gValue: p.g_value,
    bValue: p.b_value,
  }));
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Paints');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

// Maps the exact source Excel headers to our DB column names. The source
// file's `id` column is the exporting system's own row number and is
// intentionally dropped (see EXCEL_COLUMN_MAP note); `s_id` is the real,
// stable source-product identifier and is what we import and match on.
function mapRow(rawRow) {
  const mapped = {};
  for (const [excelKey, dbKey] of Object.entries(EXCEL_COLUMN_MAP)) {
    if (dbKey === 's_id_or_id') continue; // skip ambiguous `id` column
    if (excelKey in rawRow) mapped[dbKey] = rawRow[excelKey];
  }
  return mapped;
}

module.exports = { previewImport, commitImport, exportToBuffer };
