const express = require('express');
const router = express.Router({ mergeParams: true });
const { memoryUpload } = require('../middleware/upload.middleware');
const ctrl = require('../controllers/concepts.controller');

const upload = memoryUpload(10);

router.post('/', upload.single('thumbnail'), ctrl.create);
router.get('/', ctrl.list);

module.exports = router;
