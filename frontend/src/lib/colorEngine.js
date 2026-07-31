/**
 * Client-side recolor engine.
 *
 * This is the piece that used to live on a server/worker in a "Path A"
 * design — here it runs entirely in the browser on <canvas> pixel data.
 * The server never touches these pixels; it only stores the final export
 * if the user chooses to save it.
 *
 * Approach: convert the masked region to CIE LAB, replace the L (lightness)
 * channel's *relationship* is kept from the original pixel (so shadows,
 * highlights, and texture survive) while a/b (color) channels are pulled
 * toward the target paint color. This is the standard technique behind most
 * commercial paint-visualizer tools — much more realistic than a flat overlay.
 */

// --- sRGB <-> linear helpers -------------------------------------------------
function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c) {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

// --- RGB <-> XYZ <-> LAB ------------------------------------------------------
function rgbToXyz(r, g, b) {
  const rl = srgbToLinear(r), gl = srgbToLinear(g), bl = srgbToLinear(b);
  return {
    x: rl * 0.4124 + gl * 0.3576 + bl * 0.1805,
    y: rl * 0.2126 + gl * 0.7152 + bl * 0.0722,
    z: rl * 0.0193 + gl * 0.1192 + bl * 0.9505,
  };
}
function xyzToRgb(x, y, z) {
  const rl = x * 3.2406 + y * -1.5372 + z * -0.4986;
  const gl = x * -0.9689 + y * 1.8758 + z * 0.0415;
  const bl = x * 0.0557 + y * -0.204 + z * 1.057;
  return { r: linearToSrgb(rl), g: linearToSrgb(gl), b: linearToSrgb(bl) };
}

const REF_X = 0.95047, REF_Y = 1.0, REF_Z = 1.08883;
function fLab(t) { return t > 0.008856 ? Math.cbrt(t) : (7.787 * t) + 16 / 116; }
function fLabInv(t) { const t3 = t * t * t; return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787; }

function xyzToLab(x, y, z) {
  const fx = fLab(x / REF_X), fy = fLab(y / REF_Y), fz = fLab(z / REF_Z);
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}
function labToXyz(l, a, b) {
  const fy = (l + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  return { x: fLabInv(fx) * REF_X, y: fLabInv(fy) * REF_Y, z: fLabInv(fz) * REF_Z };
}

export function rgbToLab(r, g, b) {
  const { x, y, z } = rgbToXyz(r, g, b);
  return xyzToLab(x, y, z);
}
export function labToRgb(l, a, b) {
  const { x, y, z } = labToXyz(l, a, b);
  return xyzToRgb(x, y, z);
}

/**
 * Recolors the pixels of `imageData` where `maskData` alpha > threshold,
 * blending toward targetRgb while preserving each pixel's own lightness.
 *
 * @param {ImageData} imageData - source image pixels (from a <canvas> context)
 * @param {ImageData} maskData - same dimensions; alpha channel = selection strength (0-255)
 * @param {{r:number,g:number,b:number}} targetRgb - catalog paint color
 * @param {number} strength - 0..1, how strongly to pull toward the target color (default 0.85)
 * @returns {ImageData} new ImageData with the recolor applied
 */
export function applyPaintColor(imageData, maskData, targetRgb, strength = 0.85) {
  const { width, height, data } = imageData;
  const out = new ImageData(width, height);
  out.data.set(data);

  const targetLab = rgbToLab(targetRgb.r, targetRgb.g, targetRgb.b);

  for (let i = 0; i < data.length; i += 4) {
    const maskAlpha = maskData.data[i + 3] / 255; // selection strength at this pixel
    if (maskAlpha <= 0.02) continue;

    const r = data[i], g = data[i + 1], b = data[i + 2];
    const srcLab = rgbToLab(r, g, b);

    // Keep the source's own lightness (shadows/highlights/texture); pull
    // the color channels toward the target, scaled by mask strength * strength.
    const blend = maskAlpha * strength;
    const newLab = {
      l: srcLab.l, // preserve luminance entirely — this is what keeps it photorealistic
      a: srcLab.a + (targetLab.a - srcLab.a) * blend,
      b: srcLab.b + (targetLab.b - srcLab.b) * blend,
    };

    const { r: nr, g: ng, b: nb } = labToRgb(newLab.l, newLab.a, newLab.b);
    out.data[i] = nr;
    out.data[i + 1] = ng;
    out.data[i + 2] = nb;
    out.data[i + 3] = data[i + 3];
  }

  return out;
}

/**
 * Convenience wrapper: runs applyPaintColor on a canvas in place given a
 * separate mask canvas (e.g. drawn/selected by the user, or returned by a
 * segmentation step).
 */
export function paintCanvasRegion(sourceCanvas, maskCanvas, targetRgb, strength = 0.85) {
  const ctx = sourceCanvas.getContext('2d');
  const maskCtx = maskCanvas.getContext('2d');
  const { width, height } = sourceCanvas;

  const imageData = ctx.getImageData(0, 0, width, height);
  const maskData = maskCtx.getImageData(0, 0, width, height);

  const result = applyPaintColor(imageData, maskData, targetRgb, strength);
  ctx.putImageData(result, 0, 0);
  return sourceCanvas;
}
