/**
 * Provider-independent house-scene normalization.
 *
 * Extracted from replicateVisionProvider.js (its original sole caller) when
 * falVisionProvider.js became a second real consumer of the exact same
 * geometry — per-class confidence vocabulary, roof geometric clamp,
 * trim/gutter derivation, wall banding, color/style/material extraction.
 * None of this is tied to which hosted model produced the raw per-class
 * masks; it's pure geometry over `{cls: {mask, confidence, source}}`, so it
 * belongs behind neither provider specifically.
 *
 * Both providers must agree on PROMPT_CLASSES/CLASS_THRESHOLDS/SURFACE_META
 * /OBJECT_META — this is the single source of truth for that vocabulary,
 * so a class added for one provider is automatically available to the
 * other rather than risking silent drift between two copies.
 */
const { rgbToHsl } = require('./color');
const geom = require('./maskGeometry');

const PROMPT_CLASSES = ['roof', 'wall', 'window', 'door', 'tree', 'car', 'person', 'fence', 'sky', 'ground'];

// Per-class confidence floor — walls score much lower than compact,
// visually distinctive objects (doors/people) on any open-vocab
// detector/segmenter; a single global threshold either misses walls or lets
// in noise. Values carried over unchanged from the deleted local pipeline's
// own tuning (see AI_HOSTED_ARCHITECTURE.md §2).
const CLASS_THRESHOLDS = {
  roof: 0.20, wall: 0.15, door: 0.25, window: 0.30, tree: 0.30,
  car: 0.30, person: 0.30, fence: 0.30, sky: 0.15, ground: 0.15,
};

// Non-paintable house components (windows) are surfaces, not objects — kept
// visible/selectable in the UI but never offered for painting and never a
// removal candidate. Matches mockProvider.js's convention exactly.
const SURFACE_META = {
  roof: { name: 'Roof', paintable: true, role: 'roof' },
  'front-wall': { name: 'Front wall', paintable: true, role: 'primary-wall' },
  'left-wall': { name: 'Left wall', paintable: true, role: 'accent-wall' },
  'right-wall': { name: 'Right wall', paintable: true, role: 'accent-wall' },
  trim: { name: 'Trim', paintable: true, role: 'trim' },
  gutter: { name: 'Gutter', paintable: true, role: 'gutter' },
  door: { name: 'Door', paintable: true, role: 'doors' },
  windows: { name: 'Windows', paintable: false, role: null },
};

// Removable objects — the only classes objectClassification.js treats as
// safe to auto-remove (see REMOVABLE_CLASSES there). Must stay in sync.
const OBJECT_META = {
  tree: { name: 'Tree' },
  car: { name: 'Car' },
  person: { name: 'Person' },
  fence: { name: 'Fence' },
};

// ---------------------------------------------------------------------------
// Post-processing: raw per-class masks -> the app's house-understanding
// contract (ported from the deleted local pipeline's analyze(), same
// geometry, JS arrays instead of numpy — see AI_HOSTED_ARCHITECTURE.md §2).

function buildAnalysis({ masks, width: W, height: H, rgba, N, scale }) {
  const roofMaskRaw = masks.roof.mask;
  const wallMaskRaw = masks.wall.mask;
  const windowMask = masks.window.mask;
  const doorMask = masks.door.mask;
  const skyMask = masks.sky.mask;
  const groundMask = masks.ground.mask;

  const houseMask = orMask(roofMaskRaw, wallMaskRaw, N);
  const houseBbox = geom.maskBbox(houseMask, W, H);
  const bboxArea = houseBbox ? houseBbox.w * houseBbox.h : 0;
  const areaRatio = bboxArea / N;
  const present = !!houseBbox && areaRatio > 0.03;

  if (!present) {
    return {
      scale: { width: W, height: H, factor: scale },
      house: { present: false, bbox: null, confidence: 0, style: 'unknown', material: 'unknown', color: null },
      surfaces: [],
      objects: [],
      context: { skyColor: null, groundColor: null, roofColor: null, wallColor: null, lighting: 1, palette: geom.dominantPalette(rgba, N) },
    };
  }

  const { x: hx, y: hy, w: hw, h: hh } = houseBbox;

  // Roof geometric clamp: never more than the top 45% of the house bbox —
  // guards against a detector boxing the whole building as "roof" on
  // flat/under-construction roofs.
  let roof = roofMaskRaw;
  if (geom.countOn(roof) > 0) {
    const roofRowLimit = hy + Math.max(1, Math.round(hh * 0.45));
    roof = clipRows(roof, W, hy, roofRowLimit);
  }

  // Wall = detected wall, minus openings, minus roof.
  let wall = andNot(wallMaskRaw, orMask(orMask(windowMask, doorMask, N), roof, N), N);

  // Trim: boundary band around the wall + around window openings.
  const wallDilated = geom.dilate(wall, W, H, 3);
  let trim = andNot(wallDilated, wall, N);
  const windowDilated = geom.dilate(windowMask, W, H, 2);
  trim = orMask(trim, andNot(windowDilated, windowMask, N), N);
  wall = andNot(wall, trim, N);

  // Left/right accent bands at the house's outer 10% width.
  const leftEnd = Math.min(hx + hw, hx + Math.max(1, Math.round(hw * 0.1)));
  const rightStart = Math.max(hx, hx + hw - Math.max(1, Math.round(hw * 0.1)));
  const leftWall = bandCols(wall, W, hx, leftEnd);
  const rightWall = bandCols(wall, W, rightStart, hx + hw);
  const frontWall = andNot(wall, orMask(leftWall, rightWall, N), N);

  // Gutter: thin band directly under the roofline.
  let gutter = new Uint8Array(N);
  const roofBottom = bottomRowOf(roof, W, H);
  if (roofBottom !== null) {
    const gTop = roofBottom + 1;
    const gBottom = Math.min(H - 1, roofBottom + Math.max(2, Math.round(hh * 0.04)));
    if (gBottom >= gTop) {
      const band = clipRows(fullMask(N), W, gTop, gBottom + 1);
      gutter = andMask(band, orMask(orMask(frontWall, leftWall, N), orMask(rightWall, trim, N), N), N);
    }
  }

  const surfaces = [];
  const addSurface = (key, mask, confidence) => {
    if (geom.countOn(mask) === 0) return;
    const meta = SURFACE_META[key];
    surfaces.push({
      key,
      className: key,
      displayName: meta.name,
      paintable: meta.paintable,
      role: meta.role,
      confidence: round3(confidence || 0.5),
      mask: { width: W, height: H, alpha: geom.toAlpha255(mask) },
      geometry: { bbox: geom.maskBbox(mask, W, H), areaPx: geom.countOn(mask), areaRatio: geom.countOn(mask) / N },
      averageColor: geom.colorOfMask(rgba, mask),
      properties: meta.role ? { role: meta.role } : {},
    });
  };
  addSurface('roof', roof, masks.roof.confidence);
  addSurface('front-wall', frontWall, masks.wall.confidence);
  addSurface('left-wall', leftWall, masks.wall.confidence);
  addSurface('right-wall', rightWall, masks.wall.confidence);
  addSurface('trim', trim, Math.min(0.6, masks.wall.confidence || 0.5));
  addSurface('gutter', gutter, Math.min(0.5, masks.roof.confidence || 0.4));
  addSurface('door', doorMask, masks.door.confidence);
  addSurface('windows', windowMask, masks.window.confidence);

  const objects = [];
  const addObject = (key, mask, confidence) => {
    if (geom.countOn(mask) === 0) return;
    objects.push({
      key,
      className: key,
      displayName: OBJECT_META[key].name,
      paintable: false,
      confidence: round3(confidence || 0.5),
      mask: { width: W, height: H, alpha: geom.toAlpha255(mask) },
      geometry: { bbox: geom.maskBbox(mask, W, H), areaPx: geom.countOn(mask), areaRatio: geom.countOn(mask) / N },
    });
  };
  for (const cls of ['tree', 'car', 'person', 'fence']) addObject(cls, masks[cls].mask, masks[cls].confidence);

  const wallColor = geom.countOn(wallMaskRaw) > 0 ? geom.colorOfMask(rgba, wallMaskRaw) : geom.colorOfMask(rgba, houseMask);
  const roofColor = geom.countOn(roof) > 0 ? geom.colorOfMask(rgba, roof) : null;
  const skyColor = geom.medianColorOfMask(rgba, skyMask);
  const groundColor = geom.medianColorOfMask(rgba, groundMask);
  const wallL = wallColor ? rgbToHsl(wallColor.r, wallColor.g, wallColor.b).l * 100 : 50;
  const roofRowFrac = geom.countOn(houseMask) > 0 ? geom.countOn(roof) / geom.countOn(houseMask) : 0;

  const house = {
    present: true,
    bbox: houseBbox,
    confidence: Math.min(0.95, Math.max(0.3, 0.45 + areaRatio * 1.4)),
    style: geom.guessStyle(hw, hh, roofRowFrac),
    material: geom.guessMaterial(wallColor),
    color: wallColor,
  };
  const context = {
    skyColor,
    groundColor,
    roofColor,
    wallColor,
    lighting: Math.min(1.3, Math.max(0.7, wallL / 55)),
    palette: geom.dominantPalette(rgba, N),
  };

  return { scale: { width: W, height: H, factor: scale }, house, surfaces, objects, context };
}

// ---------------------------------------------------------------------------
// Small boolean-mask combinators local to this post-processing step.

function orMask(a, b, N) { const out = new Uint8Array(N); for (let i = 0; i < N; i++) out[i] = (a[i] || b[i]) ? 1 : 0; return out; }
function andMask(a, b, N) { const out = new Uint8Array(N); for (let i = 0; i < N; i++) out[i] = (a[i] && b[i]) ? 1 : 0; return out; }
function andNot(a, b, N) { const out = new Uint8Array(N); for (let i = 0; i < N; i++) out[i] = (a[i] && !b[i]) ? 1 : 0; return out; }
function fullMask(N) { const out = new Uint8Array(N); out.fill(1); return out; }

function clipRows(mask, W, yFrom, yToExclusive) {
  const out = new Uint8Array(mask.length);
  const H = mask.length / W;
  for (let y = Math.max(0, yFrom); y < Math.min(H, yToExclusive); y++) {
    const base = y * W;
    for (let x = 0; x < W; x++) out[base + x] = mask[base + x];
  }
  return out;
}

function bandCols(mask, W, xFrom, xToExclusive) {
  const out = new Uint8Array(mask.length);
  const H = mask.length / W;
  for (let y = 0; y < H; y++) {
    const base = y * W;
    for (let x = Math.max(0, xFrom); x < Math.min(W, xToExclusive); x++) out[base + x] = mask[base + x];
  }
  return out;
}

function bottomRowOf(mask, W, H) {
  for (let y = H - 1; y >= 0; y--) {
    const base = y * W;
    for (let x = 0; x < W; x++) if (mask[base + x]) return y;
  }
  return null;
}

function round3(v) { return Math.round(v * 1000) / 1000; }

module.exports = {
  PROMPT_CLASSES, CLASS_THRESHOLDS, SURFACE_META, OBJECT_META,
  buildAnalysis,
};
