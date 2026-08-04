import { applyPaintColor } from '../../../shared/lib/colorEngine';
import { assets as assetsApi } from '../../../shared/lib/api';
import { loadMaskImageData } from '../../../shared/lib/maskImage';

// Composes a batch preview of what an applied scheme would look like, using
// the exact same recolor call as LayerNode (the renderer) — same parameters,
// same base image, same mask upscaling. It is NOT a second paint engine; it
// just runs the renderer's per-layer pass against each scheme's surfaces in
// layer order, so the thumbnail matches the final canvas.
//
// Layers are painted in scheme.surfaces order (the same order applyScheme uses
// for order_index), so later surfaces stack on top exactly like the stage.

const PAINTED_STRENGTH = 0.95;
const PAINTED_LIGHTNESS_BLEND = 0.45;

export async function renderSchemePreview({ baseImageData, scheme, surfacesByClass, width, height }) {
  if (!baseImageData || !width || !height) return null;

  const baseCanvas = document.createElement('canvas');
  baseCanvas.width = width;
  baseCanvas.height = height;
  const ctx = baseCanvas.getContext('2d');
  ctx.putImageData(baseImageData, 0, 0);

  for (const entry of scheme.surfaces || []) {
    const surface = surfacesByClass.get(entry.surfaceClass);
    const paint = entry.paint;
    if (!surface || surface.paintable === false || !surface.mask_path || !paint) continue;

    const maskData = await loadMaskImageData(assetsApi.fileUrl(surface.mask_path), width, height);
    const targetRgb = { r: paint.r_value, g: paint.g_value, b: paint.b_value };
    const result = applyPaintColor(baseImageData, maskData, targetRgb, PAINTED_STRENGTH, {
      transparentOutsideMask: true,
      lightnessBlend: PAINTED_LIGHTNESS_BLEND,
    });
    ctx.putImageData(result, 0, 0);
  }

  return baseCanvas;
}

// Downscales a rendered preview canvas to a concept thumbnail (max 256px long
// edge) and returns it as a PNG blob for the concepts API.
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
