const express = require('express');
const multer = require('multer');
const router = express.Router({ mergeParams: true });
const ctrl = require('../controllers/concepts.controller');
const { imageFileFilter } = require('../middleware/uploadValidation.middleware');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: imageFileFilter,
});

router.post('/', upload.single('thumbnail'), ctrl.create);
router.get('/', ctrl.list);

module.exports = router;
