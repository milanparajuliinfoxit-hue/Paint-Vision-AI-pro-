const express = require('express');
const multer = require('multer');
const router = express.Router();
const ctrl = require('../controllers/visualizer.controller');

const maxMb = Number(process.env.MAX_UPLOAD_MB || 25);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxMb * 1024 * 1024 } });

router.post('/upload', upload.single('image'), ctrl.uploadImage);
router.get('/jobs/:jobId', ctrl.getJob);
router.post('/jobs/:jobId/cleanup', upload.single('mask'), ctrl.requestCleanup);
router.post('/jobs/:jobId/results', upload.single('result'), ctrl.saveResult);
router.get('/jobs/:jobId/results', ctrl.listResults);

module.exports = router;
