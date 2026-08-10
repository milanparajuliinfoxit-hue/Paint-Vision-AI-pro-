const express = require('express');
const router = express.Router({ mergeParams: true });
const { memoryUpload } = require('../middleware/upload.middleware');
const ctrl = require('../controllers/exports.controller');

const upload = memoryUpload(25);

router.post('/', upload.single('file'), ctrl.create);
router.get('/', ctrl.list);

module.exports = router;
