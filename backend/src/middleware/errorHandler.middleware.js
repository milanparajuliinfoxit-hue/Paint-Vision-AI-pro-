function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  console.error(JSON.stringify({ level: 'error', message: err.message, path: req.path, stack: err.stack }));
  const status = err.status || 500;
  const body = { error: err.message || 'Internal server error' };
  if (err.issues) body.issues = err.issues;
  res.status(status).json(body);
}

module.exports = { errorHandler };
