/**
 * Wraps an async route handler so a rejected promise reaches Express's error
 * middleware — replaces the `try { ... } catch (err) { next(err); }` block
 * that every controller used to repeat.
 */
function asyncHandler(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
