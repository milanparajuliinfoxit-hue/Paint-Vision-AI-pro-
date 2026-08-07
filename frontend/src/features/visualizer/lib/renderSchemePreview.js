import { applyPaintColor } from '../../../shared/lib/colorEngine';
import { assets as assetsApi } from '../../../shared/lib/api';
import { loadMaskImageData } from '../../../shared/lib/maskImage';
import { MAX_PREVIEW_DIM, computePreviewSize, createBoundedCache } from './schemePreviewCore';

// Composes a batch preview of what an applied scheme would look like, using
// the exact same recolor call as LayerNode (the renderer) — same parameters,
// same masks — so the thumbnail matches the final canvas. It is NOT a second
// paint engine; it just runs the renderer's per-layer pass against each
// scheme's surfaces in layer order.
//
// MEMORY BOUNDARY: every buffer in this module is capped at MAX_PREVIEW_DIM
// (256 px, aspect-preserving). AI scheme cards are thumbnails displayed at
// ~112 px tall, so the full workspace resolution (1600×1200) is never touched
// here — the base image and every surface mask are downscaled to preview size
// *before* any applyPaintColor pass. This is the fix for the activation crash,
// which mounted one full-resolution canvas + ImageData per scheme for every
// scheme concurrently.
//
// Layers are painted in scheme.surfaces order (the same order applyScheme uses
// for order_index). Each surface is drawn onto its own layer canvas and then
// composited over the base with drawImage — unlike putImageData (which
// overwrites the whole canvas, erasing earlier surfaces and the base), a
// layer canvas carries alpha=0 outside its mask, so surfaces stack on top of
// each other exactly like the stage.

const PAINTED_STRENGTH = 0.95;
const PAINTED_LIGHTNESS_BLEND = 0.45;

// Decoded masks at preview resolution, shared across every scheme in a run so
// the same surface PNG (roof, front-wall, …) is fetched/decoded once per
// resolution, not once per scheme. Bounded (32 entries ≈ 32 × 0.25 MB); an
// unbounded mask cache would be a new memory leak. Keyed by URL + size, which
// auto-invalidates when re-analysis re-points mask_path or the preview size
// changes.
const maskCache = createBoundedCache({ maxEntries: 32 });

// Downscales a full-resolution ImageData to at most maxDim on the long edge.
// Returns the bounded ImageData plus its dimensions; a no-op when the source
// is already within bounds. Used once per preview run so the expensive LAB
// passes always operate on the small image. The temporary source bitmap is
// closed immediately after the draw.
export async function downscaleImageData(imageData, width, height, maxDim = MAX_PREVIEW_DIM) {
  const { width: pw, height: ph } = computePreviewSize(width, height, maxDim);
  if (pw === width && ph === height) return { imageData, width, height };

  const canvas = document.createElement('canvas');
  canvas.width = pw;
  canvas.height = ph;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(imageData);
    try {
      ctx.drawImage(bitmap, 0, 0, pw, ph);
    } finally {
      bitmap.close();
    }
  } else {
    const src = document.createElement('canvas');
    src.width = width;
    src.height = height;
    src.getContext('2d').putImageData(imageData, 0, 0);
    ctx.drawImage(src, 0, 0, pw, ph);
  }

  return { imageData: ctx.getImageData(0, 0, pw, ph), width: pw, height: ph };
}

export async function renderSchemePreview({ baseImageData, scheme, surfacesByClass, width, height, signal = null }) {
  if (!baseImageData || !width || !height) return null;

  // Hard boundary: never allocate a preview buffer larger than MAX_PREVIEW_DIM.
  // Even if a caller passes workspace dimensions, processing stays bounded.
  const { imageData, width: pw, height: ph } = await downscaleImageData(baseImageData, width, height, MAX_PREVIEW_DIM);

  const baseCanvas = document.createElement('canvas');
  baseCanvas.width = pw;
  baseCanvas.height = ph;
  const ctx = baseCanvas.getContext('2d');
  ctx.putImageData(imageData, 0, 0);

  for (const entry of scheme.surfaces || []) {
    if (signal?.aborted) throw createAbortError();

    const surface = surfacesByClass.get(entry.surfaceClass);
    const paint = entry.paint;
    if (!surface || surface.paintable === false || !surface.mask_path || !paint) continue;

    const maskUrl = assetsApi.fileUrl(surface.mask_path);
    const maskKey = `${maskUrl}@${pw}x${ph}`;
    let maskData = maskCache.get(maskKey);
    if (!maskData) {
      maskData = await loadMaskImageData(maskUrl, pw, ph, signal);
      maskCache.set(maskKey, maskData);
    }

    const targetRgb = { r: paint.r_value, g: paint.g_value, b: paint.b_value };
    const result = applyPaintColor(imageData, maskData, targetRgb, PAINTED_STRENGTH, {
      transparentOutsideMask: true,
      lightnessBlend: PAINTED_LIGHTNESS_BLEND,
    });

    // One layer canvas per surface, composited over the base with drawImage so
    // earlier surfaces are preserved (putImageData would overwrite them).
    const layerCanvas = document.createElement('canvas');
    layerCanvas.width = pw;
    layerCanvas.height = ph;
    layerCanvas.getContext('2d').putImageData(result, 0, 0);
    ctx.drawImage(layerCanvas, 0, 0);
  }

  return baseCanvas;
}

// Downscales a rendered preview canvas to a concept thumbnail (max 256px long
// edge) and returns it as a PNG blob for the concepts API. Previews are
// already <=256px, so this is a same-size re-encode.
export function canvasToThumbnailBlob(canvas, maxDim = 256) {
  const scale = Math.min(1, maxDim / Math.max(canvas.width, canvas.height));
  const thumb = document.createElement('canvas');
  thumb.width = Math.max(1, Math.round(canvas.width * scale));
  thumb.height = Math.max(1, Math.round(canvas.height * scale));
  thumb.getContext('2d').drawImage(canvas, 0, 0, thumb.width, thumb.height);
  return new Promise((resolve, reject) =>
    thumb.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Thumbnail encoding failed'))), 'image/png')
  );
}

function createAbortError() {
  const err = new Error('Scheme preview aborted');
  err.name = 'AbortError';
  return err;
}
