/**
 * Structured JSON logger.
 *
 * Follows the app's existing logging strategy (single-line JSON records) while
 * centralizing the write path so services and providers never call `console`
 * directly. Info/warn/debug go to stdout, error to stderr.
 */
function emit(level, fields) {
  const line = JSON.stringify({ level, timestamp: new Date().toISOString(), ...fields });
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

module.exports = {
  info: (fields) => emit('info', fields),
  warn: (fields) => emit('warn', fields),
  error: (fields) => emit('error', fields),
  debug: (fields) => emit('debug', fields),
};
