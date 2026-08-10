const express = require('express');
const router = express.Router();
const { memoryUpload } = require('../middleware/upload.middleware');
const ctrl = require('../controllers/assets.controller');
const assetLayersRoutes = require('./assetLayers.routes');

const upload = memoryUpload(25);

router.get('/:assetId', ctrl.getAsset);
router.patch('/:assetId', ctrl.renameAsset);
router.delete('/:assetId', ctrl.deleteAsset);
router.post('/:assetId/duplicate', ctrl.duplicateAsset);
router.post('/:assetId/clean', upload.single('mask'), ctrl.requestCleanup);
router.use('/:assetId/layers', assetLayersRoutes);

module.exports = router;
