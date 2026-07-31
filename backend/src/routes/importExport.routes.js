const express = require('express');
const multer = require('multer');
const router = express.Router();
const ctrl = require('../controllers/importExport.controller');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.post('/preview', upload.single('file'), ctrl.previewImport);
router.post('/commit', ctrl.commitImport);
router.get('/export', ctrl.exportCatalog);

module.exports = router;
