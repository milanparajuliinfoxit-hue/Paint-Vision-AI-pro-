/**
 * AI sub-routes under /api/assets/:assetId/ai
 */
const express = require('express');
const ctrl = require('../controllers/ai.controller');

const router = express.Router({ mergeParams: true });

router.post('/analyze', ctrl.analyzeAsset);
router.get('/analysis', ctrl.getAnalysis);
router.post('/recommendations', ctrl.generateRecommendations);
router.get('/recommendations', ctrl.listRecommendations);

// Autonomous pipeline (Phase 2): frontend fires this right after upload
// instead of requiring a manual "Analyze" click; /status is polled until
// the stage reaches 'ready' or 'failed'.
router.post('/process', ctrl.processAsset);
router.get('/status', ctrl.getPipelineStatus);

// Promptable wall detection (Phase 3): point-click segmentation & refinement
router.post('/segment-wall', ctrl.segmentWall);

module.exports = router;
