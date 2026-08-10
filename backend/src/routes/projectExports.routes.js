const express = require('express');
const router = express.Router({ mergeParams: true });
const ctrl = require('../controllers/exports.controller');
const { imageUpload } = require('../middleware/upload.middleware');

router.post('/', imageUpload('file', { maxMb: 25, required: true }), ctrl.create);
router.get('/', ctrl.list);

module.exports = router;
