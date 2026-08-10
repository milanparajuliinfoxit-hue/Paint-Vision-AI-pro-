const logger = require('../services/logger.service');

// Maps errors thrown by libraries (multer, express.json, the AI providers)
// onto the status code they actually mean, so a 25MB upload or a malformed
// JSON body is reported as a client error instead of a generic 500.
function statusFor(err) {
  if (err.status || err.statusCode) return err.status || err.statusCode;
  if (err.name === 'MulterError') return err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
  if (err.type === 'entity.parse.failed') return 400;
  if (err.type === 'entity.too.large') return 413;
  if (err.name === 'ProviderError') return 502;
  if (err.name === 'TimeoutError') return 504;
  if (err.code === 'ENOENT') return 404;
  return 500;
}

function errorHandler(err, req, res, next) {
  const status = statusFor(err);

  logger.error({
    message: err.message,
    name: err.name,
    code: err.code,
    status,
    method: req.method,
    path: req.originalUrl,
    provider: err.provider,
    requestId: err.requestId,
    stack: err.stack,
    cause: err.cause ? { message: err.cause.message, name: err.cause.name } : undefined,
  });

  // A streamed response (e.g. res.sendFile) can fail after headers are out —
  // writing another body would throw and lose the error entirely, so hand
  // back to Express, which destroys the socket.
  if (res.headersSent) return next(err);

  // Client errors describe what the caller did wrong and are safe to return.
  // Server errors are logged in full above but only summarized to the client
  // so stack traces / SQL text / provider keys never leave the process.
  const body =
    status < 500
      ? { error: err.message || 'Request failed' }
      : { error: 'Internal server error' };

  if (err.name === 'ProviderError') {
    body.error = err.message; // provider failures are actionable for the user
    body.provider = err.provider;
    body.retriable = !!err.retriable;
  }
  if (err.code) body.code = err.code;

  res.status(status).json(body);
}

module.exports = { errorHandler, statusFor };
