/**
 * Request correlation.
 *
 * Assigns req.requestId so a log line from a controller, a service, and a
 * repository call can all be tied back to the same HTTP request — the
 * missing piece when debugging something like "DELETE /api/projects/2 ->
 * 404": without it, a request-level failure log and a deeper service-level
 * log for the same request are two unrelated lines with no way to prove
 * they belong together.
 *
 * Sits alongside morgan (human-readable console access log, unchanged) —
 * this instead emits one structured, persisted record per request through
 * the centralized logger, which morgan's plain-text output doesn't provide.
 */
const { randomUUID } = require('crypto');
const logger = require('../services/logger.service');

function requestId(req, res, next) {
  req.requestId = randomUUID();
  res.setHeader('X-Request-Id', req.requestId);

  const startedAt = Date.now();
  res.on('finish', () => {
    logger.info({
      event: 'request.completed',
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });

  next();
}

module.exports = { requestId };
