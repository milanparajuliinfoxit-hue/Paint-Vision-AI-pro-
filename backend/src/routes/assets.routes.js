const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/assets.controller');
const assetLayersRoutes = require('./assetLayers.routes');
const { imageUpload } = require('../middleware/upload.middleware');

router.get('/:assetId', ctrl.getAsset);
router.patch('/:assetId', ctrl.renameAsset);
router.delete('/:assetId', ctrl.deleteAsset);
router.post('/:assetId/duplicate', ctrl.duplicateAsset);
router.post('/:assetId/clean', imageUpload('mask', { maxMb: 25 }), ctrl.requestCleanup);
router.use('/:assetId/layers', assetLayersRoutes);

module.exports = router;
