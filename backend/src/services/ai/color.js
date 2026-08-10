/**
 * Color math shared by the AI understanding + recommendation modules.
 *
 * The client keeps its own copy in frontend/src/shared/lib/colorEngine.js —
 * the renderer remains the only authority on *applying* paint. This module
 * only feeds the understanding layers: dominant-color extraction, LAB
 * distance for segmentation heuristics, and HSL targets for catalog scoring.
 */

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function srgbToLinear(v) {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// sRGB -> CIELAB (D65). Same formulas the renderer's colorEngine uses, so
// distances computed here are consistent with the paint it applies.
function rgbToLab(r, g, b) {
  const rl = srgbToLinear(r);
  const gl = srgbToLinear(g);
  const bl = srgbToLinear(b);

  let x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / 0.95047;
  let y = (rl * 0.2126 + gl * 0.7152 + bl * 0.0722);
  let z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / 1.08883;

  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x); y = f(y); z = f(z);

  return {
    l: 116 * y - 16,
    a: 500 * (x - y),
    b: 200 * (y - z),
  };
}

function labDistance(a, b) {
  const dl = a.l - b.l, da = a.a - b.a, db = a.b - b.b;
  return Math.sqrt(dl * dl + da * da + db * db);
}

function rgbToHsl(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  switch (max) {
    case rn: h = (gn - bn) / d + (gn < bn ? 6 : 0); break;
    case gn: h = (bn - rn) / d + 2; break;
    default: h = (rn - gn) / d + 4;
  }
  return { h: (h / 6) * 360, s, l };
}

function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  if (s === 0) {
    const v = Math.round(clamp(l, 0, 1) * 255);
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hr = h / 360;
  return {
    r: Math.round(clamp(hue2rgb(p, q, hr + 1 / 3), 0, 1) * 255),
    g: Math.round(clamp(hue2rgb(p, q, hr), 0, 1) * 255),
    b: Math.round(clamp(hue2rgb(p, q, hr - 1 / 3), 0, 1) * 255),
  };
}

function rgbToHex(r, g, b) {
  const to2 = (v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
  return `#${to2(r)}${to2(g)}${to2(b)}`.toUpperCase();
}

// Average RGB of an array of {r,g,b} samples (memory-safe for big images —
// callers pass a sampled subset).
function averageRgb(samples) {
  if (!samples.length) return { r: 0, g: 0, b: 0 };
  let r = 0, g = 0, b = 0;
  for (const s of samples) { r += s.r; g += s.g; b += s.b; }
  const n = samples.length;
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

module.exports = { rgbToLab, labDistance, rgbToHsl, hslToRgb, rgbToHex, averageRgb, clamp };
