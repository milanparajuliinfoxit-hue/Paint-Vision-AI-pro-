const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/layers.controller');
const { imageUpload } = require('../middleware/upload.middleware');

// Only mask-edit-mode brush updates send a file; the upload middleware no-ops
// for the plain-JSON PATCH requests (color/opacity/order/etc. changes).
router.patch('/:id', imageUpload('mask'), ctrl.updateLayer);
router.delete('/:id', ctrl.deleteLayer);
router.post('/:id/restore', ctrl.restoreLayer);

module.exports = router;
