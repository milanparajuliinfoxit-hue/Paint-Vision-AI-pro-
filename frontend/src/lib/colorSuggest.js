import { rgbToLab } from './colorEngine';

/**
 * Rule-based suggestion engine — runs client-side, no ML model call.
 * Deliberately explainable/tunable rather than a black box (see requirements
 * doc, Section 6.2): it reads fixed elements already in the photo (roof,
 * landscaping, whatever's outside the paintable mask) and proposes catalog
 * colors that are complementary/analogous to them.
 */

// Sample a sparse grid of pixels *outside* the paintable mask to find the
// property's fixed, unpainted context colors (roof, trim, greenery, sky...).
export function extractContextColors(imageData, maskData, sampleStep = 8, maxSamples = 5) {
  const { width, height, data } = imageData;
  const buckets = new Map(); // quantized color -> count

  for (let y = 0; y < height; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      const i = (y * width + x) * 4;
      const maskAlpha = maskData.data[i + 3] / 255;
      if (maskAlpha > 0.2) continue; // skip pixels inside the "to be painted" mask

      const r = data[i], g = data[i + 1], b = data[i + 2];
      // Quantize to reduce noise (buckets of 24 per channel)
      const key = `${Math.round(r / 24)},${Math.round(g / 24)},${Math.round(b / 24)}`;
      const entry = buckets.get(key) || { r: 0, g: 0, b: 0, count: 0 };
      entry.r += r; entry.g += g; entry.b += b; entry.count += 1;
      buckets.set(key, entry);
    }
  }

  const ranked = [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, maxSamples)
    .map((e) => ({ r: Math.round(e.r / e.count), g: Math.round(e.g / e.count), b: Math.round(e.b / e.count) }));

  return ranked;
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s; const l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return { h: h * 360, s, l };
}
function hslToRgb(h, s, l) {
  h /= 360;
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  if (s === 0) { const v = Math.round(l * 255); return { r: v, g: v, b: v }; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  };
}

function labDistance(a, b) {
  return Math.sqrt((a.l - b.l) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2);
}

/**
 * @param {Array<{r,g,b}>} contextColors - from extractContextColors
 * @param {Array} catalog - paint rows from the backend, each with r_value/g_value/b_value
 * @param {number} count - how many suggestions to return
 */
export function suggestColors(contextColors, catalog, count = 5) {
  if (contextColors.length === 0 || catalog.length === 0) return [];

  // Build a small set of "theory targets": complementary + analogous hues
  // relative to the dominant context color, plus a neutral safe option.
  const dominant = contextColors[0];
  const { h, s } = rgbToHsl(dominant.r, dominant.g, dominant.b);

  const targetHues = [
    (h + 180) % 360,        // complementary
    (h + 30) % 360,         // analogous +
    (h - 30 + 360) % 360,   // analogous -
    h,                      // matching/monochrome
  ];

  const targetRgbs = targetHues.map((th) => hslToRgb(th, Math.max(0.25, s), 0.55));
  const targetLabs = targetRgbs.map((c) => rgbToLab(c.r, c.g, c.b));

  const scored = catalog.map((paint) => {
    const paintLab = rgbToLab(paint.r_value, paint.g_value, paint.b_value);
    const bestDistance = Math.min(...targetLabs.map((t) => labDistance(t, paintLab)));
    return { paint, distance: bestDistance };
  });

  scored.sort((a, b) => a.distance - b.distance);

  // De-duplicate by color_code in case of near-identical catalog entries.
  const seen = new Set();
  const results = [];
  for (const { paint } of scored) {
    if (seen.has(paint.color_code)) continue;
    seen.add(paint.color_code);
    results.push(paint);
    if (results.length >= count) break;
  }
  return results;
}
