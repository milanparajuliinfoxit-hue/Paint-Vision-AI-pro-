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

module.exports = router;
