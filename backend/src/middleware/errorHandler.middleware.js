const logger = require('../services/logger.service');

// Client-visible messages are only echoed back for deliberate 4xx errors —
// unexpected 5xx failures can carry driver/filesystem internals, so they are
// logged server-side and answered with a generic message.
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  // Multer rejects (oversized/too many files) are client errors, not crashes.
  if (!err.status && err.name === 'MulterError') {
    err.status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
  }
  const status = err.status || 500;
  logger.error({ message: err.message, path: req.path, status, stack: err.stack });
  const body = status < 500
    ? { error: err.message || 'Request failed' }
    : { error: 'Internal server error' };
  res.status(status).json(body);
}

module.exports = { errorHandler };
