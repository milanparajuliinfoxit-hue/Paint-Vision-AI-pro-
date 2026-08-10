const express = require('express');
const router = express.Router({ mergeParams: true });
const { memoryUpload } = require('../middleware/upload.middleware');
const ctrl = require('../controllers/layers.controller');

const upload = memoryUpload(10);

router.post('/', upload.single('mask'), ctrl.createLayer);
router.get('/', ctrl.listLayers);

module.exports = router;
