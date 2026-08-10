const express = require('express');
const multer = require('multer');
const router = express.Router({ mergeParams: true });
const ctrl = require('../controllers/exports.controller');
const { imageFileFilter } = require('../middleware/uploadValidation.middleware');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: imageFileFilter,
});

router.post('/', upload.single('file'), ctrl.create);
router.get('/', ctrl.list);

module.exports = router;
