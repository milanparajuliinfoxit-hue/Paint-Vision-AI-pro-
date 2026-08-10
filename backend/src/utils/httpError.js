/**
 * Errors carrying an HTTP status, so route handlers can `throw` instead of
 * hand-rolling `return res.status(...).json({ error })` at every guard.
 * errorHandler.middleware turns these back into the same JSON response.
 */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

const badRequest = (message) => new HttpError(400, message);
const notFound = (message) => new HttpError(404, message);
const conflict = (message) => new HttpError(409, message);
const notImplemented = (message) => new HttpError(501, message);

module.exports = { HttpError, badRequest, notFound, conflict, notImplemented };
