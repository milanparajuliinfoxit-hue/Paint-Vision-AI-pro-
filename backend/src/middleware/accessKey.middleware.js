const crypto = require('crypto');

/**
 * There is no user authentication in this app by design (single dealer,
 * internal tool). This middleware is a much lighter infra-level guard —
 * a shared key so the API isn't wide open on the public internet.
 *
 * Outside development the key is mandatory: an unset or placeholder value
 * makes every request fail closed instead of silently exposing the whole API.
 */
const PLACEHOLDER_KEYS = new Set(['', 'change-me-long-random-string', 'changeme', 'change-me']);
const MIN_KEY_LENGTH = 16;

function isUsableKey(key) {
  return typeof key === 'string' && !PLACEHOLDER_KEYS.has(key.trim()) && key.trim().length >= MIN_KEY_LENGTH;
}

function isDevelopment() {
  return (process.env.NODE_ENV || 'development') === 'development';
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAccessKey(req, res, next) {
  const configuredKey = process.env.API_ACCESS_KEY;

  if (!isUsableKey(configuredKey)) {
    if (isDevelopment()) return next();
    return res.status(503).json({
      error: 'Server misconfigured: API_ACCESS_KEY must be set to a non-placeholder value of at least '
        + `${MIN_KEY_LENGTH} characters.`,
    });
  }

  const providedKey = req.header('x-api-key');
  if (!providedKey || !timingSafeEqual(providedKey, configuredKey.trim())) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
}

module.exports = { requireAccessKey, isUsableKey, MIN_KEY_LENGTH };
