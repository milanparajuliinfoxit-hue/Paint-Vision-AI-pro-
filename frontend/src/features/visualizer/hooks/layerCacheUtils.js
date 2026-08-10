// Pure, dependency-free helpers for layer query-cache updates — kept
// separate from useLayers.js (which imports the API client, and therefore
// import.meta.env) purely so this stays importable from a plain Node test
// without needing a Vite/browser environment.

// Appends if `item.id` isn't already in `list`, otherwise replaces that
// entry in place, preserving its position. Used by useCreateLayer's
// onSuccess — the same mutation backs the AI-surface idempotent upsert
// path (useApplySurface.js), where the server response can be an *update*
// to an already-cached layer, not a new one; a blind append would leave a
// stale duplicate sitting alongside the update.
export function upsertById(list, item) {
  return list.some((l) => l.id === item.id)
    ? list.map((l) => (l.id === item.id ? item : l))
    : [...list, item];
}
