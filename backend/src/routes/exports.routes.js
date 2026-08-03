const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/exports.controller');

router.get('/:id', ctrl.get);

module.exports = router;
