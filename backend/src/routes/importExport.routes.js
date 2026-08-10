const express = require('express');
const router = express.Router();
const { memoryUpload } = require('../middleware/upload.middleware');
const ctrl = require('../controllers/importExport.controller');

const upload = memoryUpload(10);

router.post('/preview', upload.single('file'), ctrl.previewImport);
router.post('/commit', ctrl.commitImport);
router.get('/export', ctrl.exportCatalog);

module.exports = router;
