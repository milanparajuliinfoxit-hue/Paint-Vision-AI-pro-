const express = require('express');
const multer = require('multer');
const router = express.Router({ mergeParams: true });
const ctrl = require('../controllers/assets.controller');

const maxMb = Number(process.env.MAX_UPLOAD_MB || 25);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxMb * 1024 * 1024 } });

router.post('/', upload.single('image'), ctrl.uploadAsset);
router.get('/', ctrl.listAssets);

module.exports = router;
