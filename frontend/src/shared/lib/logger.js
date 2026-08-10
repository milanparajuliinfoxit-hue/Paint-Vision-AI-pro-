/**
 * Minimal browser-side logger.
 *
 * The backend has a structured JSON logger (services/logger.service.js) —
 * this is its frontend counterpart, scoped to what a browser can actually
 * do: there's no file to persist to, so this just routes through console
 * in a consistent, greppable shape instead of ad-hoc console.error calls
 * scattered per component. Errors still surface to the user via the toast
 * system separately — this is for DevTools/bug-report visibility, not
 * user-facing messaging.
 *
 * Must never receive API keys, tokens, or other secrets — there's nothing
 * server-side-only that this app currently exposes to the browser to log
 * in the first place (see shared/lib/api.js), but keep it that way.
 */
function emit(level, event, fields = {}) {
  const record = { level, timestamp: new Date().toISOString(), event, ...fields };
  const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
  // eslint-disable-next-line no-console
  console[method](`[${event}]`, record);
}

export const logger = {
  info: (event, fields) => emit('info', event, fields),
  warn: (event, fields) => emit('warn', event, fields),
  error: (event, fields) => emit('error', event, fields),
};
