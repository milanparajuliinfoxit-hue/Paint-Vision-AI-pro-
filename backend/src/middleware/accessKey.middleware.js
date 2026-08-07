/**
 * There is no user authentication in this app by design (single dealer,
 * internal tool). This middleware is a much lighter infra-level guard —
 * a shared key so the API isn't wide open on the public internet.
 * Remove entirely if the app will only ever run on a private network.
 */

// True when no real key is configured (unset, or still the .env.example
// placeholder) — the app intentionally stays open in that case for local/LAN
// dev convenience, but every caller that checks a key funnels through this
// one function so that behavior can't drift between routes.
function keyNotConfigured() {
  const configuredKey = process.env.API_ACCESS_KEY;
  return !configuredKey || configuredKey === 'change-me-long-random-string';
}

function isValidKey(providedKey) {
  if (keyNotConfigured()) return true;
  return providedKey === process.env.API_ACCESS_KEY;
}

function requireAccessKey(req, res, next) {
  if (isValidKey(req.header('x-api-key'))) return next();
  return res.status(401).json({ error: 'Invalid or missing API key' });
}

module.exports = { requireAccessKey, isValidKey, keyNotConfigured };
