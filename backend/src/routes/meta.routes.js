/**
 * Meta routes under /api/meta — non-versioned, feature-flag-aware platform info.
 */
const express = require('express');
const ctrl = require('../controllers/ai.controller');

const router = express.Router();

router.get('/', ctrl.getMeta);

module.exports = router;
