const express = require('express');
const multer = require('multer');
const router = express.Router();
const ctrl = require('../controllers/assets.controller');
const assetLayersRoutes = require('./assetLayers.routes');
const aiRoutes = require('./ai.routes');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

router.get('/:assetId', ctrl.getAsset);
router.patch('/:assetId', ctrl.renameAsset);
router.delete('/:assetId', ctrl.deleteAsset);
router.post('/:assetId/duplicate', ctrl.duplicateAsset);
router.post('/:assetId/clean', upload.single('mask'), ctrl.requestCleanup);
router.use('/:assetId/layers', assetLayersRoutes);
router.use('/:assetId/ai', aiRoutes);

module.exports = router;
