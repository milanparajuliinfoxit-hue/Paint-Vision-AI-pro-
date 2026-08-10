const express = require('express');
const multer = require('multer');
const router = express.Router();
const ctrl = require('../controllers/layers.controller');
const { imageFileFilter } = require('../middleware/uploadValidation.middleware');

// Only mask-edit-mode brush updates send a file; multer no-ops for the
// plain-JSON PATCH requests (color/opacity/order/etc. changes).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: imageFileFilter,
});

router.patch('/:id', upload.single('mask'), ctrl.updateLayer);
router.delete('/:id', ctrl.deleteLayer);
router.post('/:id/restore', ctrl.restoreLayer);

module.exports = router;
