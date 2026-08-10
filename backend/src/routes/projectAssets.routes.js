const express = require('express');
const router = express.Router({ mergeParams: true });
const { memoryUpload } = require('../middleware/upload.middleware');
const ctrl = require('../controllers/assets.controller');

const upload = memoryUpload(Number(process.env.MAX_UPLOAD_MB || 25));

router.post('/', upload.single('image'), ctrl.uploadAsset);
router.get('/', ctrl.listAssets);

module.exports = router;
