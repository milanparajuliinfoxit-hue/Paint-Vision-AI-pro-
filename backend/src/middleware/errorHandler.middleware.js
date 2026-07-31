function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  console.error(JSON.stringify({ level: 'error', message: err.message, path: req.path, stack: err.stack }));
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
}

module.exports = { errorHandler };
