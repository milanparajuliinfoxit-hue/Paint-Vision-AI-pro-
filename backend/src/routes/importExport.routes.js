const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/importExport.controller');
const { spreadsheetUpload } = require('../middleware/upload.middleware');

router.post('/preview', spreadsheetUpload('file'), ctrl.previewImport);
router.post('/commit', ctrl.commitImport);
router.get('/export', ctrl.exportCatalog);

module.exports = router;
