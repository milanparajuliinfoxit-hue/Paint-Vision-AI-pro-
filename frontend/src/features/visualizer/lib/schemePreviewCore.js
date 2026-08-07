// Pure, browser-free helpers for the AI Schemes preview pipeline.
//
// Kept in their own module (no DOM/canvas/API imports) so the memory/CPU
// boundaries are testable with node --test and stay independent of the
// rendering code. Everything here is a hard guarantee the preview path relies
// on: previews are never larger than MAX_PREVIEW_DIM, caches are always
// bounded, and cache keys always include the analysis/scheme identity.

export const MAX_PREVIEW_DIM = 256;

// Longest-edge-clamped preview dimensions that preserve aspect ratio. Never
// upscales; never returns 0. This is the single source of truth for how big
// an AI scheme thumbnail may be — the expensive applyPaintColor/mask passes
// run at these dimensions, never at workspace resolution.
export function computePreviewSize(width, height, maxDim = MAX_PREVIEW_DIM) {
  const longest = Math.max(width, height);
  if (longest <= maxDim) return { width, height };
  const scale = maxDim / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

// Stable identity of a rendered preview. Re-analysis changes analysisId (job
// id), regenerating schemes or re-analyzing changes the scheme/analysis ids,
// so a cache hit is only ever served for the exact same analysis+scheme+size.
export function buildPreviewCacheKey({ assetId, schemeId, analysisId, size }) {
  return `${assetId}:${schemeId}:${analysisId || 'na'}:${size}`;
}

// Bounded FIFO-ish Map used for the mask cache and the preview cache. Mirrors
// the existing bounded in-memory cache pattern in VisualizerWorkspace
// (maskCacheRef) — unbounded image caches are exactly the memory-leak shape
// this incident was about, so every cache in the preview path is capped.
export function createBoundedCache({ maxEntries = 32 } = {}) {
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      while (map.size > maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    has(key) {
      return map.has(key);
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
  };
}
