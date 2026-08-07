/**
 * House-understanding contract assembly — pure geometry, no model.
 *
 * Takes raw class masks produced by a segmentation model (currently the
 * hosted Grounded-SAM2 chain in providers/hfVisionProvider.js, previously the
 * local Python pipeline) and derives the app's structured house-understanding
 * contract:
 *
 *   { scale, house, surfaces, objects, context }
 *
 * This is a direct JS port of the geometric post-processing in the former
 * backend/vision-service/pipeline.py (roof row clip, wall-minus-openings,
 * trim dilation, left/right accent bands, gutter band, context colors, style
 * and material guesses). Keeping it pure and provider-agnostic means the same
 * contract is produced whether masks come from a hosted model, a local model,
 * or a synthetic test fixture — and it can be exercised offline with no keys.
 *
 * Mask convention: each class mask is a Uint8Array (0/1) in row-major order
 * (index = y * width + x) at the working resolution `width` x `height`.
 * `rgb` is a Uint8Array of RGB triplets (length width*height*3).
 */

const { rgbToHsl, averageRgb, clamp } = require('./color');

const SURFACE_META = {
  roof: { name: 'Roof', role: 'roof' },
  'front-wall': { name: 'Front wall', role: 'primary-wall' },
  'left-wall': { name: 'Left wall', role: 'accent-wall' },
  'right-wall': { name: 'Right wall', role: 'accent-wall' },
  trim: { name: 'Trim', role: 'trim' },
  gutter: { name: 'Gutter', role: 'gutter' },
  door: { name: 'Door', role: 'doors' },
};

const OBJECT_META = {
  window: { name: 'Windows', key: 'windows' },
  tree: { name: 'Tree', key: 'tree' },
  car: { name: 'Car', key: 'car' },
  person: { name: 'Person', key: 'person' },
  fence: { name: 'Fence', key: 'fence' },
};

const ROOF_MAX_FRAC = 0.45;

function assembleContract({ width, height, rgb, classMasks = {}, classConfidences = {}, scale = 1 }) {
  const N = width * height;

  const roofMask = classMasks.roof || emptyMask(N);
  const wallRawMask = classMasks.wall || emptyMask(N);
  const windowMask = classMasks.window || emptyMask(N);
  const doorMask = classMasks.door || emptyMask(N);
  const skyMask = classMasks.sky || emptyMask(N);
  const groundMask = classMasks.ground || emptyMask(N);

  const houseMask = union(roofMask, wallRawMask);
  const houseBbox = bboxOf(houseMask, width, height);
  const present = houseBbox !== null && (houseBbox.w * houseBbox.h) / N > 0.03;

  if (!present) {
    return {
      scale: { width, height, factor: scale },
      house: { present: false, bbox: null, confidence: 0, style: 'unknown', material: 'unknown', color: null },
      surfaces: [],
      objects: [],
      context: {
        skyColor: null,
        groundColor: null,
        roofColor: null,
        wallColor: null,
        lighting: 1,
        palette: dominantPalette(rgb, N),
      },
    };
  }

  const { x: hx, y: hy, w: hw, h: hh } = houseBbox;

  // Sanity-bound the roof: a roof is never more than the top portion of the
  // building's silhouette (matches pipeline.py — a zero-shot detector can box
  // the whole building for "roof" on flat-roofed / under-construction houses).
  const roof = roofMask.slice();
  if (anyPixel(roof)) {
    const roofRowLimit = hy + Math.max(1, Math.round(hh * ROOF_MAX_FRAC));
    for (let y = roofRowLimit; y < height; y++) {
      const base = y * width;
      for (let x = 0; x < width; x++) roof[base + x] = 0;
    }
  }

  // Wall region, minus openings and minus the roof.
  let wall = wallRawMask.slice();
  for (let i = 0; i < N; i++) {
    if (windowMask[i] || doorMask[i] || roof[i]) wall[i] = 0;
  }

  // Trim: boundary band around the wall + around window openings.
  const wallDilated = dilate(wall, width, height, 3);
  const windowDilated = dilate(windowMask, width, height, 2);
  const trim = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if ((wallDilated[i] && !wall[i]) || (windowDilated[i] && !windowMask[i])) trim[i] = 1;
  }
  for (let i = 0; i < N; i++) {
    if (trim[i]) wall[i] = 0;
  }

  // Left/right accent bands at the house's outer 10%.
  const leftEnd = Math.min(hx + hw, hx + Math.max(1, Math.round(hw * 0.1)));
  const rightStart = Math.max(hx, hx + hw - Math.max(1, Math.round(hw * 0.1)));
  const leftWall = new Uint8Array(N);
  const rightWall = new Uint8Array(N);
  const frontWall = new Uint8Array(N);
  for (let y = hy; y < hy + hh; y++) {
    for (let x = hx; x < hx + hw; x++) {
      const i = y * width + x;
      if (!wall[i]) continue;
      if (x < leftEnd) leftWall[i] = 1;
      else if (x >= rightStart) rightWall[i] = 1;
      else frontWall[i] = 1;
    }
  }

  // Gutter: thin band directly under the roofline.
  const gutter = new Uint8Array(N);
  if (anyPixel(roof)) {
    let roofBottom = -1;
    for (let y = 0; y < height; y++) {
      let any = false;
      const base = y * width;
      for (let x = 0; x < width; x++) {
        if (roof[base + x]) { any = true; break; }
      }
      if (any) roofBottom = y;
    }
    const gTop = roofBottom + 1;
    const gBottom = Math.min(height - 1, roofBottom + Math.max(2, Math.round(hh * 0.04)));
    for (let y = gTop; y <= gBottom; y++) {
      const base = y * width;
      for (let x = hx; x < hx + hw; x++) {
        const i = base + x;
        if (frontWall[i] || leftWall[i] || rightWall[i] || trim[i]) gutter[i] = 1;
      }
    }
  }

  const surfaces = [];
  const addSurface = (key, mask, confidence) => {
    if (!anyPixel(mask)) return;
    const meta = SURFACE_META[key];
    surfaces.push({
      key,
      className: key,
      displayName: meta.name,
      paintable: true,
      role: meta.role,
      confidence: round3(confidence),
      mask: { width, height, alpha: toAlpha255(mask) },
      geometry: maskGeometry(mask, width, height, N),
      averageColor: avgColor(rgb, mask),
      properties: { role: meta.role },
    });
  };

  addSurface('roof', roof, classConfidences.roof || 0.5);
  addSurface('front-wall', frontWall, classConfidences.wall || 0.5);
  addSurface('left-wall', leftWall, classConfidences.wall || 0.5);
  addSurface('right-wall', rightWall, classConfidences.wall || 0.5);
  addSurface('trim', trim, Math.min(0.6, classConfidences.wall || 0.5));
  addSurface('gutter', gutter, Math.min(0.5, classConfidences.roof || 0.4));
  addSurface('door', doorMask, classConfidences.door || 0.5);

  const objects = [];
  const addObject = (key, mask, confidence) => {
    if (!anyPixel(mask)) return;
    const meta = OBJECT_META[key];
    objects.push({
      key: meta.key,
      className: meta.key,
      displayName: meta.name,
      paintable: false,
      confidence: round3(confidence),
      mask: { width, height, alpha: toAlpha255(mask) },
      geometry: maskGeometry(mask, width, height, N),
    });
  };

  addObject('window', windowMask, classConfidences.window || 0.5);
  for (const cls of ['tree', 'car', 'person', 'fence']) {
    const m = classMasks[cls];
    if (m && anyPixel(m)) addObject(cls, m, classConfidences[cls] || 0.5);
  }

  const wallColor = anyPixel(wallRawMask) ? avgColor(rgb, wallRawMask) : avgColor(rgb, houseMask);
  const roofColor = anyPixel(roof) ? avgColor(rgb, roof) : null;
  const skyColor = medianColor(rgb, skyMask);
  const groundColor = medianColor(rgb, groundMask);

  const wallL = wallColor ? rgbToHsl(wallColor.r, wallColor.g, wallColor.b).l * 100 : 50;
  const roofRowFrac = roofCount(roof) / Math.max(1, roofCount(houseMask));

  const house = {
    present: true,
    bbox: houseBbox,
    confidence: round3(Math.min(0.95, Math.max(0.3, 0.45 + (hw * hh) / N * 1.4))),
    style: guessStyle(hw, hh, roofRowFrac),
    material: guessMaterial(wallColor),
    color: wallColor,
  };

  const context = {
    skyColor,
    groundColor,
    roofColor,
    wallColor,
    lighting: round3(clamp(wallL / 55, 0.7, 1.3)),
    palette: dominantPalette(rgb, N),
  };

  return {
    scale: { width, height, factor: scale },
    house,
    surfaces,
    objects,
    context,
  };
}

// ---------------------------------------------------------------------------
// Helpers (ports of pipeline.py)

function emptyMask(n) {
  return new Uint8Array(n);
}

function anyPixel(mask) {
  for (let i = 0; i < mask.length; i++) if (mask[i]) return true;
  return false;
}

function roofCount(mask) {
  let c = 0;
  for (let i = 0; i < mask.length; i++) c += mask[i];
  return c;
}

function union(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] || b[i];
  return out;
}

function bboxOf(mask, width, height) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % width;
    const y = (i / width) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (maxX < minX) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// Square dilation (max-pool with radius r) on a Uint8 0/1 mask.
function dilate(mask, width, height, r) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(height - 1, y + r);
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(width - 1, x + r);
      for (let yy = y0; yy <= y1; yy++) {
        const base = yy * width;
        for (let xx = x0; xx <= x1; xx++) out[base + xx] = 1;
      }
    }
  }
  return out;
}

function maskGeometry(mask, width, height, N) {
  const bbox = bboxOf(mask, width, height);
  const areaPx = roofCount(mask);
  return { bbox, areaPx, areaRatio: areaPx / N };
}

function toAlpha255(mask) {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] ? 255 : 0;
  return out;
}

function avgColor(rgb, mask) {
  const samples = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    samples.push({ r: rgb[i * 3], g: rgb[i * 3 + 1], b: rgb[i * 3 + 2] });
  }
  return averageRgb(samples);
}

function medianColor(rgb, mask) {
  const rs = [], gs = [], bs = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    rs.push(rgb[i * 3]);
    gs.push(rgb[i * 3 + 1]);
    bs.push(rgb[i * 3 + 2]);
  }
  if (!rs.length) return null;
  rs.sort((a, b) => a - b);
  gs.sort((a, b) => a - b);
  bs.sort((a, b) => a - b);
  const mid = rs.length >> 1;
  return { r: rs[mid], g: gs[mid], b: bs[mid] };
}

function dominantPalette(rgb, N, n = 5) {
  const buckets = new Map();
  for (let i = 0; i < N; i++) {
    const o = i * 3;
    const key = ((rgb[o] >> 4) << 8) | ((rgb[o + 1] >> 4) << 4) | (rgb[o + 2] >> 4);
    const e = buckets.get(key) || { r: 0, g: 0, b: 0, c: 0 };
    e.r += rgb[o];
    e.g += rgb[o + 1];
    e.b += rgb[o + 2];
    e.c++;
    buckets.set(key, e);
  }
  return [...buckets.values()]
    .sort((a, b) => b.c - a.c)
    .slice(0, n)
    .map((e) => ({ r: Math.round(e.r / e.c), g: Math.round(e.g / e.c), b: Math.round(e.b / e.c) }));
}

function guessStyle(w, h, roofFrac) {
  if (!h) return 'unknown';
  if (w / h > 1.35) return 'ranch';
  if (roofFrac > 0.12) return 'traditional';
  return 'modern';
}

function guessMaterial(wallColor) {
  const { h, s, l } = rgbToHsl(wallColor.r, wallColor.g, wallColor.b);
  if (s > 0.22 && h >= 6 && h <= 48) return l < 0.45 ? 'brick' : 'wood';
  if (l > 0.6 && s < 0.16) return 'render';
  return 'unknown';
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

module.exports = { assembleContract, SURFACE_META, OBJECT_META, bboxOf, dilate };
