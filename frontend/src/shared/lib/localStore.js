import { reportError } from './errorReporter';

// localStorage is unavailable in private-browsing modes and throws once the
// origin's quota is full. Every read/write in the app goes through here so a
// failure degrades to the fallback value and gets logged, instead of either
// disappearing into a bare `catch {}` or throwing out of a render/effect.

export function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) ?? fallback;
  } catch (err) {
    reportError(err, { action: `Reading saved "${key}"`, silent: true });
    return fallback;
  }
}

export function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    reportError(err, { action: `Saving "${key}"`, silent: true });
    return false;
  }
}

export function readString(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw;
  } catch (err) {
    reportError(err, { action: `Reading saved "${key}"`, silent: true });
    return fallback;
  }
}

export function writeString(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    reportError(err, { action: `Saving "${key}"`, silent: true });
    return false;
  }
}
