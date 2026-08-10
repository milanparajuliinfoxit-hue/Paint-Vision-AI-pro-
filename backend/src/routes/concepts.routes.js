const express = require('express');
const router = express.Router({ mergeParams: true });
const ctrl = require('../controllers/concepts.controller');
const { imageUpload } = require('../middleware/upload.middleware');

router.post('/', imageUpload('thumbnail'), ctrl.create);
router.get('/', ctrl.list);

module.exports = router;
