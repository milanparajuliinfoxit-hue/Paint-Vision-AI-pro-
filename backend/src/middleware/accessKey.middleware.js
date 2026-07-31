/**
 * There is no user authentication in this app by design (single dealer,
 * internal tool). This middleware is a much lighter infra-level guard —
 * a shared key so the API isn't wide open on the public internet.
 * Remove entirely if the app will only ever run on a private network.
 */
function requireAccessKey(req, res, next) {
  const configuredKey = process.env.API_ACCESS_KEY;
  if (!configuredKey || configuredKey === 'change-me-long-random-string') {
    // Not configured — allow through in local dev, but this should be set before deploying.
    return next();
  }
  const providedKey = req.header('x-api-key');
  if (providedKey !== configuredKey) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
}

module.exports = { requireAccessKey };
