// There's no auth in this app, so per-user preferences (favorites, recents,
// collections, UI state) persist per-browser. Reads tolerate absent or
// corrupt entries so one bad value can't break the page that reads it.

export function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or private-mode failures: persistence is best-effort here.
  }
}
