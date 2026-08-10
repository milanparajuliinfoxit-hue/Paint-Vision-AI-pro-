// Single funnel for every failure the UI doesn't handle inline.
//
// Most writes in the workspace are fire-and-forget (`mutation.mutate(...)`
// from the undo/redo command stack, history appends, autosave), so a rejected
// request used to disappear with nothing on screen and nothing in the console
// — the user kept painting on top of state the server never accepted. Anything
// that fails now goes through here: it is always logged, and the app registers
// a handler (a toast) so the user is told.

let handler = null;

// `App` installs the toast handler once mounted; until then reports are still
// logged, never dropped.
export function setErrorHandler(fn) {
  handler = fn;
  return () => {
    if (handler === fn) handler = null;
  };
}

/**
 * @param {unknown} error   the thrown value
 * @param {object} options
 * @param {string} options.action  what the user was doing ("Save layer color")
 * @param {boolean} options.silent log only — for best-effort caches (IndexedDB
 *                                 draft, localStorage) where failure doesn't
 *                                 affect correctness and a toast would be noise
 */
export function reportError(error, { action = 'Operation', silent = false } = {}) {
  const err = error instanceof Error ? error : new Error(String(error));
  const message = `${action} failed: ${err.message}`;

  if (silent) {
    console.warn(message, err);
    return err;
  }

  console.error(message, err);
  handler?.(message, err);
  return err;
}
