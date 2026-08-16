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

// Gemini recolor visualization — async job pattern (fire, then poll), same
// shape as /process + /status. See GEMINI_RECOLORING_IMPLEMENTATION_PLAN.md.
router.post('/visualize', ctrl.requestVisualization);
router.get('/visualizations', ctrl.listVisualizations);
router.get('/visualizations/:visualizationId', ctrl.getVisualization);

// Gemini house preparation / targeted object removal — async, unified
// revision model (governing brief §13/§31): both return an
// ai_visualizations row, polled the same generic way as /visualize via
// GET /visualizations/:visualizationId — no separate status endpoint per
// task type. Separate from POST /clean (ClipDrop/HF mask-guided removal),
// which is untouched.
router.post('/isolate', ctrl.requestIsolation);
router.post('/remove-objects', ctrl.requestObjectRemoval);

module.exports = router;
