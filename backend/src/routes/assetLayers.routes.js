const express = require('express');
const multer = require('multer');
const router = express.Router({ mergeParams: true });
const ctrl = require('../controllers/layers.controller');
const { imageFileFilter } = require('../middleware/uploadValidation.middleware');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: imageFileFilter,
});

router.post('/', upload.single('mask'), ctrl.createLayer);
router.get('/', ctrl.listLayers);

module.exports = router;
