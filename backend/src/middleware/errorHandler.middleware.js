const logger = require('../services/logger.service');

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  // Stack trace is server-side only (logs/error.log + stderr) — the response
  // to the client never includes it (see the res.json below).
  logger.error({
    event: 'request.failed',
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    status,
    message: err.message,
    stack: err.stack,
  });
  res.status(status).json({ error: err.message || 'Internal server error' });
}

module.exports = { errorHandler };
