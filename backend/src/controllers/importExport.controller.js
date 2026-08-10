const importService = require('../services/excelImport.service');
const paintsModel = require('../services/paints.model');
const { asyncHandler } = require('../utils/asyncHandler');
const { badRequest } = require('../utils/httpError');

const previewImport = asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No file uploaded');
  res.json(await importService.previewImport(req.file.buffer));
});

const commitImport = asyncHandler(async (req, res) => {
  const { validRows, fileName, duplicateStrategy } = req.body;
  if (!Array.isArray(validRows) || validRows.length === 0) {
    throw badRequest('validRows is required (re-run preview and pass its "valid" array)');
  }
  const result = await importService.commitImport({
    validRows,
    fileName: fileName || 'unknown.xlsx',
    duplicateStrategy: duplicateStrategy || 'update',
  });
  res.json(result);
});

const exportCatalog = asyncHandler(async (req, res) => {
  const { rows } = await paintsModel.list({ page: 1, pageSize: 100000 });
  const buffer = importService.exportToBuffer(rows);
  res.setHeader('Content-Disposition', 'attachment; filename="paint-catalog-export.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

module.exports = { previewImport, commitImport, exportCatalog };
