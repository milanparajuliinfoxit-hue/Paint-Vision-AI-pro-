const express = require('express');
const multer = require('multer');
const router = express.Router();
const ctrl = require('../controllers/importExport.controller');
const { xlsxFileFilter } = require('../middleware/uploadValidation.middleware');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: xlsxFileFilter,
});

router.post('/preview', upload.single('file'), ctrl.previewImport);
router.post('/commit', ctrl.commitImport);
router.get('/export', ctrl.exportCatalog);

module.exports = router;
