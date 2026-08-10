/**
 * Structured JSON logger.
 *
 * Follows the app's existing logging strategy (single-line JSON records) while
 * centralizing the write path so services and providers never call `console`
 * directly. Every record goes to console (info/warn/debug -> stdout, error ->
 * stderr) AND is persisted to backend/logs/ — application.log gets every
 * level, error.log gets error-level only (for fast incident scanning without
 * grepping the full stream).
 *
 * File writes are best-effort: a full disk or permissions problem must never
 * take the request down or silence console output, so failures here are
 * swallowed (not re-thrown, not re-logged — that risks a write-failure loop).
 */
const fs = require('fs');
const path = require('path');

// Overridable so tests can point at a scratch directory / tiny rotation
// threshold instead of writing real megabytes into backend/logs/.
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '..', '..', 'logs');
const APPLICATION_LOG = path.join(LOG_DIR, 'application.log');
const ERROR_LOG = path.join(LOG_DIR, 'error.log');

// Simple size-based rotation — one rollover file, not a full history. This
// app's log volume doesn't justify a dependency (e.g. winston-daily-rotate)
// for what's fundamentally "don't let one file grow forever."
const MAX_BYTES = Number(process.env.LOG_MAX_BYTES) || 5 * 1024 * 1024;

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch {
  // Handled per-write below (fs.appendFileSync will also fail, silently).
}

function rotateIfNeeded(filePath) {
  try {
    const { size } = fs.statSync(filePath);
    if (size > MAX_BYTES) {
      fs.renameSync(filePath, `${filePath}.1`);
    }
  } catch {
    // ENOENT (file doesn't exist yet) is the common case — nothing to rotate.
  }
}

function appendToFile(filePath, line) {
  try {
    rotateIfNeeded(filePath);
    fs.appendFileSync(filePath, `${line}\n`);
  } catch {
    // Best-effort — console logging (the caller's other write) still happened.
  }
}

function emit(level, fields) {
  const line = JSON.stringify({ level, timestamp: new Date().toISOString(), ...fields });
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${line}\n`);

  appendToFile(APPLICATION_LOG, line);
  if (level === 'error') appendToFile(ERROR_LOG, line);
}

// Redacts known-sensitive header names if a caller ever logs a headers
// object — nothing in this codebase does today (request logging below only
// records method/path/status/duration), but this exists so a future call
// site has a safe default instead of reinventing redaction.
const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key']);
function redactHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? '[REDACTED]' : value;
  }
  return out;
}

module.exports = {
  info: (fields) => emit('info', fields),
  warn: (fields) => emit('warn', fields),
  error: (fields) => emit('error', fields),
  debug: (fields) => emit('debug', fields),
  redactHeaders,
};
