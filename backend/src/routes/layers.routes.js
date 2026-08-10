const express = require('express');
const router = express.Router();
const { memoryUpload } = require('../middleware/upload.middleware');
const ctrl = require('../controllers/layers.controller');

// Only mask-edit-mode brush updates send a file; multer no-ops for the
// plain-JSON PATCH requests (color/opacity/order/etc. changes).
const upload = memoryUpload(10);

router.patch('/:id', upload.single('mask'), ctrl.updateLayer);
router.delete('/:id', ctrl.deleteLayer);
router.post('/:id/restore', ctrl.restoreLayer);

module.exports = router;
