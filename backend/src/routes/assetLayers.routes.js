const express = require('express');
const router = express.Router({ mergeParams: true });
const ctrl = require('../controllers/layers.controller');
const { imageUpload } = require('../middleware/upload.middleware');

router.post('/', imageUpload('mask'), ctrl.createLayer);
router.get('/', ctrl.listLayers);

module.exports = router;
