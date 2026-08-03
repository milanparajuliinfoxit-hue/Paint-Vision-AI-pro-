const express = require('express');
const router = express.Router({ mergeParams: true });
const ctrl = require('../controllers/history.controller');

router.post('/', ctrl.append);
router.get('/', ctrl.list);

module.exports = router;
