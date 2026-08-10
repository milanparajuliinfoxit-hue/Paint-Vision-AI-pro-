const importService = require('../services/excelImport.service');
const paintsModel = require('../services/paints.model');
const { isRealXlsx } = require('../middleware/uploadValidation.middleware');

async function previewImport(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    // multer's fileFilter only checked the client-declared Content-Type
    // (and now accepts the common "application/octet-stream" fallback,
    // since real clients legitimately send that for .xlsx) — this checks
    // the actual bytes. Needed because the xlsx library itself doesn't
    // reject non-spreadsheet input; it silently returns an empty workbook.
    if (!isRealXlsx(req.file.buffer)) {
      return res.status(400).json({ error: 'That file is not a valid Excel (.xlsx) file.' });
    }
    const report = await importService.previewImport(req.file.buffer);
    res.json(report);
  } catch (err) { next(err); }
}

async function commitImport(req, res, next) {
  try {
    const { validRows, fileName, duplicateStrategy } = req.body;
    if (!Array.isArray(validRows) || validRows.length === 0) {
      return res.status(400).json({ error: 'validRows is required (re-run preview and pass its "valid" array)' });
    }
    const result = await importService.commitImport({
      validRows,
      fileName: fileName || 'unknown.xlsx',
      duplicateStrategy: duplicateStrategy || 'update',
    });
    res.json(result);
  } catch (err) { next(err); }
}

async function exportCatalog(req, res, next) {
  try {
    const { rows } = await paintsModel.list({ page: 1, pageSize: 100000 });
    const buffer = importService.exportToBuffer(rows);
    res.setHeader('Content-Disposition', 'attachment; filename="paint-catalog-export.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) { next(err); }
}

module.exports = { previewImport, commitImport, exportCatalog };
