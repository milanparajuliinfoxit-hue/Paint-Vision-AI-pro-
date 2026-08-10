const express = require('express');
const multer = require('multer');
const router = express.Router();
const ctrl = require('../controllers/assets.controller');
const aiCtrl = require('../controllers/ai.controller');
const assetLayersRoutes = require('./assetLayers.routes');
const aiRoutes = require('./ai.routes');
const { imageFileFilter } = require('../middleware/uploadValidation.middleware');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: imageFileFilter,
});

router.get('/:assetId', ctrl.getAsset);
router.patch('/:assetId', ctrl.renameAsset);
router.delete('/:assetId', ctrl.deleteAsset);
router.post('/:assetId/duplicate', ctrl.duplicateAsset);
router.post('/:assetId/clean', upload.single('mask'), ctrl.requestCleanup);
router.use('/:assetId/layers', assetLayersRoutes);
router.use('/:assetId/ai', aiRoutes);

// Direct fallback route for wall segmentation
router.post('/:assetId/ai/segment-wall', aiCtrl.segmentWall);

module.exports = router;
