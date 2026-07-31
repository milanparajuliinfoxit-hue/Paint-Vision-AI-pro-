const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/paints.controller');

router.get('/', ctrl.listPaints);
router.get('/:id', ctrl.getPaint);
router.post('/', ctrl.createPaint);
router.put('/:id', ctrl.updatePaint);
router.delete('/:id', ctrl.deletePaint);

module.exports = router;
