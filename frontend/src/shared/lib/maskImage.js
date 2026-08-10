// Shared mask-image loading. All AI/layer masks are alpha PNGs on disk served
// via assets.fileUrl(...); every consumer (brush constraints, layer apply,
// scheme previews) needs the same read-draw-resample path. Centralizing it
// here keeps the pixel handling in one place (previously duplicated across
// useAiAnalysis.js / useApplySurface.js / VisualizerWorkspace.jsx).

export function loadImage(url, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const onAbort = () => {
      img.src = '';
      reject(createAbortError());
    };
    const done = () => signal?.removeEventListener('abort', onAbort);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    img.onload = () => { done(); resolve(img); };
    img.onerror = () => { done(); reject(new Error('Image failed to load')); };
    img.src = url;
  });
}

function createAbortError() {
  const err = new Error('Image load aborted');
  err.name = 'AbortError';
  return err;
}

// Draws a mask image up to width x height and returns its full ImageData —
// used as the merge base for brush mask edits.
export async function loadMaskImageData(url, width, height, signal) {
  const img = await loadImage(url, signal);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

// The alpha channel only, flattened to a Uint8Array of length width*height —
// used as the brush constraint (surface lock) and for hit-testing surfaces.
// Both callers (useSurfaceConstraintAlpha, useSurfaceAlphaGrids) commonly
// load the *same* mask at the *same* canvas resolution independently, and
// this re-decodes on every asset-analysis refetch (e.g. each AI pipeline
// status transition) — cached, bounded by an LRU cap so it can't grow
// unbounded across a long session.
//
// `versionKey` (typically the analysis/job id) matters because a
// re-analysis overwrites the same mask_path filename with new content — the
// URL string alone doesn't change, so without a version component in the
// cache key this would keep serving the *previous* analysis's mask forever.
const alphaGridCache = new Map();
const ALPHA_GRID_CACHE_LIMIT = 48;

export async function loadAlphaGrid(url, width, height, versionKey = '') {
  const key = `${url}@${width}x${height}@${versionKey}`;
  const cached = alphaGridCache.get(key);
  if (cached) {
    alphaGridCache.delete(key);
    alphaGridCache.set(key, cached); // touch -> most-recently-used
    return cached;
  }

  const data = (await loadMaskImageData(url, width, height)).data;
  const grid = new Uint8Array(width * height);
  for (let i = 0; i < grid.length; i++) grid[i] = data[i * 4 + 3];

  alphaGridCache.set(key, grid);
  if (alphaGridCache.size > ALPHA_GRID_CACHE_LIMIT) {
    alphaGridCache.delete(alphaGridCache.keys().next().value);
  }
  return grid;
}

// Draws a mask image up to width x height and encodes it as a PNG blob —
// the exact format the layers API stores (server saves the uploaded buffer).
export async function surfaceMaskToPngBlob(url, width, height) {
  const img = await loadImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, width, height);
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Mask encoding failed'))), 'image/png')
  );
  return blob;
}
