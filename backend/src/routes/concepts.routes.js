const express = require('express');
const multer = require('multer');
const router = express.Router({ mergeParams: true });
const ctrl = require('../controllers/concepts.controller');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.post('/', upload.single('thumbnail'), ctrl.create);
router.get('/', ctrl.list);

module.exports = router;
