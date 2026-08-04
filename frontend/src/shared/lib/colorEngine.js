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
// srgbToLinear is only ever called with integer 0-255 channel bytes (from
// ImageData or hexToRgb), so a 256-entry LUT replaces a Math.pow() call per
// channel per pixel — meaningful on the applyPaintColor hot loop and on
// hover-preview recomputes, with identical output to the formula version.
const SRGB_TO_LINEAR_LUT = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR_LUT[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function srgbToLinear(c) {
  return SRGB_TO_LINEAR_LUT[c < 0 ? 0 : c > 255 ? 255 : c];
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

// Lightness (L*) only, skipping the a/b math — used where only luminance is
// needed (the paint-coverage mean in applyPaintColor), roughly a third of
// the cost of a full LAB conversion.
export function labL(r, g, b) {
  const y = srgbToLinear(r) * 0.2126 + srgbToLinear(g) * 0.7152 + srgbToLinear(b) * 0.0722;
  return 116 * fLab(y / REF_Y) - 16;
}
export function labToRgb(l, a, b) {
  const { x, y, z } = labToXyz(l, a, b);
  return xyzToRgb(x, y, z);
}

export function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

export function labDistance(a, b) {
  return Math.sqrt((a.l - b.l) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2);
}

/**
 * Recolors the pixels of `imageData` where `maskData` alpha > threshold,
 * blending toward targetRgb while preserving each pixel's own lightness.
 *
 * @param {ImageData} imageData - source image pixels (from a <canvas> context)
 * @param {ImageData} maskData - same dimensions; alpha channel = selection strength (0-255)
 * @param {{r:number,g:number,b:number}} targetRgb - catalog paint color
 * @param {number} strength - 0..1, how strongly to pull toward the target color (default 0.85)
 * @param {{
 *   transparentOutsideMask?: boolean,
 *   lightnessBlend?: number,
 * }} [opts]
 *   - `transparentOutsideMask`: when true, pixels outside the mask get
 *     alpha=0 instead of keeping the source image, so the result composites
 *     as one Konva layer among several stacked ones rather than a single
 *     flattened canvas (requirements doc, Section 5.2).
 *   - `lightnessBlend` (0..1): how much the paint's own lightness should
 *     anchor the result. Plain per-pixel blending keeps the source's L
 *     entirely, which makes paint read as a translucent overlay (a light
 *     color over a dark wall stays dark). When > 0, the masked region's
 *     mean lightness is shifted toward the target's while each pixel's
 *     *relative* brightness (its shading offset from the wall mean) is
 *     preserved — a real coat of paint that keeps texture and lighting.
 * @returns {ImageData} new ImageData with the recolor applied
 */
export function applyPaintColor(imageData, maskData, targetRgb, strength = 0.85, opts = {}) {
  const { transparentOutsideMask = false, lightnessBlend = 0 } = opts;
  const { width, height, data } = imageData;
  const out = new ImageData(width, height);
  out.data.set(data);

  const targetLab = rgbToLab(targetRgb.r, targetRgb.g, targetRgb.b);

  // Mean lightness of the masked region, computed on a sampled grid (every
  // 3rd pixel) so the extra pass stays cheap. Used only when the paint is
  // allowed to change the region's overall lightness.
  let meanL = null;
  if (lightnessBlend > 0) {
    let sum = 0, count = 0;
    for (let y = 0; y < height; y += 3) {
      const row = y * width;
      for (let x = 0; x < width; x += 3) {
        const i = (row + x) * 4;
        const a = maskData.data[i + 3];
        if (a < 8) continue;
        sum += labL(data[i], data[i + 1], data[i + 2]) * a;
        count += a;
      }
    }
    if (count > 0) meanL = sum / count;
  }

  for (let i = 0; i < data.length; i += 4) {
    const maskAlpha = maskData.data[i + 3] / 255; // selection strength at this pixel
    if (maskAlpha <= 0.02) {
      if (transparentOutsideMask) out.data[i + 3] = 0;
      continue;
    }

    const r = data[i], g = data[i + 1], b = data[i + 2];
    const srcLab = rgbToLab(r, g, b);

    // Keep the source's own lightness relationship (shadows/highlights/
    // texture), optionally re-anchored onto the paint's lightness; pull the
    // color channels toward the target, scaled by mask strength * strength.
    const blend = maskAlpha * strength;
    let l = srcLab.l;
    if (lightnessBlend > 0 && meanL != null) {
      // Fully-painted pixel = target lightness + the pixel's shading offset
      // from the wall mean (scaled by how much shading to preserve), then
      // eased in by the feather/blend so edges still wash in naturally.
      const painted = targetLab.l + (srcLab.l - meanL) * (1 - lightnessBlend);
      l = srcLab.l + (painted - srcLab.l) * blend;
    }
    const newLab = {
      l,
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
