const express = require('express');
const router = express.Router({ mergeParams: true });
const ctrl = require('../controllers/assets.controller');
const { imageUpload } = require('../middleware/upload.middleware');

const maxMb = Number(process.env.MAX_UPLOAD_MB || 25);

router.post('/', imageUpload('image', { maxMb, required: true }), ctrl.uploadAsset);
router.get('/', ctrl.listAssets);

module.exports = router;
