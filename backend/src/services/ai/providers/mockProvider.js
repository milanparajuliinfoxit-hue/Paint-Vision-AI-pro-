/**
 * Mock house-understanding provider (heuristic, explainable, zero-dependency
 * on an ML vendor). This is the DEFAULT provider so the whole AI pipeline is
 * demonstrable end-to-end without API keys — and it follows the same spirit
 * as the existing client-side colorSuggest.js: rule-based, tunable, honest
 * about its confidence.
 *
 * It runs a small image-ops pipeline server-side (via `jimp`):
 *   downscale -> per-pixel LAB/HSL features -> sky/vegetation masking ->
 *   house bounding box -> roof / wall / trim / door / window / gutter masks ->
 *   object candidates (trees, obstructions, neighbour houses) -> context colors.
 *
 * Everything it returns is the exact structured contract a real segmentation
 * provider would return (see providers/httpVisionProvider.js), so swapping
 * `AI_ANALYSIS_PROVIDER=mock` for a real vendor changes no other code.
 *
 * It is a stand-in, not a model: it cannot detect cars reliably or classify
 * complex architectural styles. Real deployments should set a real provider.
 */
const Jimp = require('jimp');
const aiConfig = require('../../../config/aiConfig');
const { rgbToLab, labDistance, rgbToHsl, averageRgb, clamp } = require('../color');

const ID = 'mock';
const VERSION = 'mock-understanding-v1';
const DEFAULT_MAX_DIM = 640;

const CLASS_META = {
  'front-wall': { name: 'Front wall', paintable: true, role: 'primary-wall' },
  'left-wall': { name: 'Left wall', paintable: true, role: 'accent-wall' },
  'right-wall': { name: 'Right wall', paintable: true, role: 'accent-wall' },
  roof: { name: 'Roof', paintable: true, role: 'roof' },
  trim: { name: 'Trim', paintable: true, role: 'trim' },
  gutter: { name: 'Gutter', paintable: true, role: 'gutter' },
  door: { name: 'Door', paintable: true, role: 'doors' },
  windows: { name: 'Windows', paintable: false, role: null },
  tree: { name: 'Tree', paintable: false, role: null },
  obstacle: { name: 'Obstruction', paintable: false, role: null },
  'neighbor-house': { name: 'Neighbour house', paintable: false, role: null },
};

function supports(capability) {
  return capability === 'house-understanding';
}

async function run(capability, input) {
  if (!supports(capability)) {
    throw new Error(`mock provider does not support capability "${capability}"`);
  }
  return { output: await analyze(input.buffer), confidence: 1, modelVersion: VERSION };
}

// ---------------------------------------------------------------------------

async function analyze(buffer) {
  const image = await Jimp.read(buffer);
  const maxDim = aiConfig.getAnalysisMaxDim() || DEFAULT_MAX_DIM;
  const scale = Math.min(1, maxDim / Math.max(image.getWidth(), image.getHeight()));
  if (scale < 1) {
    image.resize(Math.max(1, Math.round(image.getWidth() * scale)), Math.max(1, Math.round(image.getHeight() * scale)));
  }
  const W = image.getWidth();
  const H = image.getHeight();
  const N = W * H;
  const rgba = image.bitmap.data;

  // Per-pixel feature arrays.
  const lab = new Float32Array(N * 3);
  const hsl = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    const L = rgbToLab(rgba[o], rgba[o + 1], rgba[o + 2]);
    lab[i * 3] = L.l; lab[i * 3 + 1] = L.a; lab[i * 3 + 2] = L.b;
    const C = rgbToHsl(rgba[o], rgba[o + 1], rgba[o + 2]);
    hsl[i * 3] = C.h; hsl[i * 3 + 1] = C.s; hsl[i * 3 + 2] = C.l;
  }

  // Classifiers (Uint8 boolean).
  const sky = new Uint8Array(N);
  const green = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const y = (i / W) | 0;
    const l = lab[i * 3], s = hsl[i * 3 + 1];
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    if (l > 66 && s < 0.55 && y < H * 0.72 && l < 98) sky[i] = 1;
    if (g > r + 10 && g > b + 8 && l > 18 && l < 85) green[i] = 1;
  }

  // --- House bounding box --------------------------------------------------
  const rowCount = new Uint32Array(H);
  for (let i = 0; i < N; i++) {
    if (!sky[i] && !green[i]) rowCount[(i / W) | 0]++;
  }
  const rowAbove = new Uint8Array(H);
  for (let y = 0; y < H; y++) rowAbove[y] = rowCount[y] > W * 0.2 ? 1 : 0;

  let bestTop = -1, bestBottom = -1, bestLen = 0, run = 0;
  for (let y = 0; y < H; y++) {
    if (rowAbove[y]) {
      run++;
      if (run > bestLen) { bestLen = run; bestTop = y - run + 1; bestBottom = y; }
    } else run = 0;
  }
  // Fallback for photos where the house fills the frame (no sky/ground split).
  if (bestLen < Math.max(4, H * 0.08)) { bestTop = Math.round(H * 0.15); bestBottom = Math.round(H * 0.85); }
  const top = bestTop, bottom = bestBottom;
  const bandH = bottom - top + 1;

  const colCount = new Uint32Array(W);
  for (let x = 0; x < W; x++) {
    let c = 0;
    for (let y = top; y <= bottom; y++) {
      const i = y * W + x;
      if (!sky[i] && !green[i]) c++;
    }
    colCount[x] = c;
  }
  const colThresh = Math.max(1, bandH * 0.45);
  let houseLeft = -1, houseRight = -1, cRun = 0, cBest = 0;
  for (let x = 0; x < W; x++) {
    if (colCount[x] > colThresh) {
      cRun++;
      if (cRun > cBest) { cBest = cRun; houseLeft = x - cRun + 1; houseRight = x; }
    } else cRun = 0;
  }
  if (houseLeft === -1) { houseLeft = 0; houseRight = W - 1; }
  if (houseRight - houseLeft < W * 0.15) { houseLeft = 0; houseRight = W - 1; }

  const bbox = { x: houseLeft, y: top, w: houseRight - houseLeft + 1, h: bandH };
  const bboxArea = bbox.w * bbox.h;
  const areaRatio = bboxArea / (W * H);
  const present = areaRatio > 0.03;

  // --- Wall color (dominant color of the house structure region) ----------
  const structureIdx = [];
  for (let y = top; y <= bottom; y++) {
    for (let x = houseLeft; x <= houseRight; x++) {
      const i = y * W + x;
      if (!sky[i] && !green[i] && lab[i * 3] > 14) structureIdx.push(i);
    }
  }
  const wallColor = dominantColor(rgba, structureIdx);

  // --- Roof: top rows whose color diverges from the wall -------------------
  const roofRows = new Uint8Array(bandH);
  {
    let stopped = false;
    for (let y = top; y <= bottom; y++) {
      if (stopped) break;
      const samples = [];
      let darkCount = 0, n = 0;
      for (let x = houseLeft; x <= houseRight; x++) {
        const i = y * W + x;
        if (sky[i] || green[i]) continue;
        n++;
        if (lab[i * 3] < 45) darkCount++;
        if (samples.length < 4000) samples.push({ r: rgba[i * 4], g: rgba[i * 4 + 1], b: rgba[i * 4 + 2] });
      }
      if (n === 0) continue;
      const rowColor = averageRgb(samples);
      const rowLab = rgbToLab(rowColor.r, rowColor.g, rowColor.b);
      const wallLab = rgbToLab(wallColor.r, wallColor.g, wallColor.b);
      const isRoofRow = (darkCount / n) > 0.4 || labDistance(rowLab, wallLab) > 30;
      roofRows[y - top] = isRoofRow ? 1 : 0;
      if (!isRoofRow && (y - top) > Math.floor(bandH * 0.12)) stopped = true;
    }
  }
  let roofBottomY = top - 1;
  let roofRowCount = 0;
  for (let y = top; y <= bottom; y++) {
    if (roofRows[y - top]) { roofBottomY = y; roofRowCount++; }
  }
  const hasRoof = roofRowCount >= Math.max(2, bandH * 0.04);

  // --- Mask helpers bound to this image ------------------------------------
  const countOn = (m) => {
    let c = 0;
    for (let i = 0; i < m.length; i++) c += m[i];
    return c;
  };
  const maskBbox = (m) => {
    let minX = W, minY = H, maxX = -1, maxY = -1;
    for (let i = 0; i < m.length; i++) {
      if (!m[i]) continue;
      const x = i % W, y = (i / W) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (maxX < minX) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  };
  const avgOf = (m) => {
    const idx = [];
    for (let i = 0; i < N; i++) if (m[i]) idx.push(i);
    return dominantColor(rgba, idx);
  };
  const makeSurface = (key, mask, confidence, props) => {
    const meta = CLASS_META[key];
    return {
      key,
      className: key,
      displayName: meta.name,
      paintable: meta.paintable,
      role: (props && props.role) || meta.role || null,
      confidence,
      mask: { width: W, height: H, alpha: mask.slice() },
      geometry: { bbox: maskBbox(mask), areaPx: countOn(mask), areaRatio: countOn(mask) / N },
      averageColor: avgOf(mask),
      properties: props || {},
    };
  };

  const surfaces = [];
  const objects = [];

  if (present) {
    const roofMask = new Uint8Array(N);
    const wallMask = new Uint8Array(N);
    const trimMask = new Uint8Array(N);
    for (let y = top; y <= bottom; y++) {
      for (let x = houseLeft; x <= houseRight; x++) {
        const i = y * W + x;
        if (sky[i] || green[i]) continue;
        if (hasRoof && y <= roofBottomY && roofRows[y - top]) roofMask[i] = 1;
        else wallMask[i] = 1;
      }
    }

    // Openings: dark/bright blobs inside the wall region (windows + door).
    const openingMask = new Uint8Array(N);
    for (let y = top + 2; y <= bottom - 2; y++) {
      for (let x = houseLeft + 2; x <= houseRight - 2; x++) {
        const i = y * W + x;
        if (!wallMask[i]) continue;
        const l = lab[i * 3], s = hsl[i * 3 + 1];
        if (l < 40 || (l > 82 && s < 0.12)) openingMask[i] = 1;
      }
    }
    const comps = connectedComponents(openingMask, W, H, Math.max(2, Math.round(bboxArea * 0.0015)));
    const windowComps = [];
    const doorComps = [];
    for (const c of comps) {
      const cw = c.maxX - c.minX + 1, ch = c.maxY - c.minY + 1;
      const cy = (c.minY + c.maxY) / 2;
      if (cw > bbox.w * 0.7 || ch > bandH * 0.75) continue; // full-width shadows, not openings
      if (c.size > bboxArea * 0.14) continue;
      const isDoor = cy > top + bandH * 0.55 && cw >= bbox.w * 0.07 && cw <= bbox.w * 0.4 && ch >= bandH * 0.18;
      (isDoor ? doorComps : windowComps).push(c);
    }

    const windowsMask = new Uint8Array(N);
    const doorMask = new Uint8Array(N);
    for (const c of windowComps) fillComp(windowsMask, c);
    for (const c of doorComps) fillComp(doorMask, c);

    // Trim: boundary band around the wall + border band around windows.
    const wallDilated = dilate(wallMask, W, H, 3);
    for (let i = 0; i < N; i++) {
      if (wallDilated[i] && !wallMask[i]) trimMask[i] = 1;
    }
    const windowDilated = dilate(windowsMask, W, H, 2);
    for (let i = 0; i < N; i++) {
      if (windowDilated[i] && !windowsMask[i]) trimMask[i] = 1;
    }
    for (let i = 0; i < N; i++) {
      if (windowsMask[i] || doorMask[i]) wallMask[i] = 0;
    }

    if (hasRoof) surfaces.push(makeSurface('roof', roofMask, 0.7, { role: 'roof' }));
    surfaces.push(makeSurface('front-wall', wallMask, 0.8, { role: 'primary-wall' }));
    surfaces.push(makeSurface('trim', trimMask, 0.55, { role: 'trim' }));
    if (countOn(doorMask) > 0) surfaces.push(makeSurface('door', doorMask, 0.5, { role: 'doors' }));
    if (countOn(windowsMask) > 0) surfaces.push(makeSurface('windows', windowsMask, 0.5, null));

    if (hasRoof) {
      const gutterMask = new Uint8Array(N);
      const gTop = roofBottomY + 1;
      const gBottom = Math.min(bottom, roofBottomY + Math.max(2, Math.round(bandH * 0.04)));
      for (let y = gTop; y <= gBottom; y++) {
        for (let x = houseLeft; x <= houseRight; x++) {
          const i = y * W + x;
          if (wallMask[i] || trimMask[i]) gutterMask[i] = 1;
        }
      }
      if (countOn(gutterMask) > 0) surfaces.push(makeSurface('gutter', gutterMask, 0.4, { role: 'gutter' }));
    }

    if (houseLeft > W * 0.04) {
      const leftWall = new Uint8Array(N);
      const lEnd = Math.min(houseRight, houseLeft + Math.ceil(bbox.w * 0.1));
      for (let y = top; y <= bottom; y++) {
        for (let x = houseLeft; x < lEnd; x++) {
          const i = y * W + x;
          if (wallMask[i] || trimMask[i]) leftWall[i] = 1;
        }
      }
      if (countOn(leftWall) > 0) surfaces.push(makeSurface('left-wall', leftWall, 0.5, { role: 'accent-wall' }));
    }
    if (houseRight < W * 0.96) {
      const rightWall = new Uint8Array(N);
      const rStart = Math.max(houseLeft, houseRight - Math.ceil(bbox.w * 0.1));
      for (let y = top; y <= bottom; y++) {
        for (let x = rStart; x <= houseRight; x++) {
          const i = y * W + x;
          if (wallMask[i] || trimMask[i]) rightWall[i] = 1;
        }
      }
      if (countOn(rightWall) > 0) surfaces.push(makeSurface('right-wall', rightWall, 0.5, { role: 'accent-wall' }));
    }

    // --- Objects (non-paintable: protected from paint, removable) ----------
    const treeComps = connectedComponents(green, W, H, Math.max(3, Math.round(N * 0.006)));
    for (const c of treeComps) {
      const cm = new Uint8Array(N);
      fillComp(cm, c);
      objects.push({
        key: `tree-${objects.length + 1}`,
        className: 'tree',
        displayName: CLASS_META.tree.name,
        paintable: false,
        confidence: 0.6,
        mask: { width: W, height: H, alpha: cm },
        geometry: { bbox: { x: c.minX, y: c.minY, w: c.maxX - c.minX + 1, h: c.maxY - c.minY + 1 }, areaPx: c.size, areaRatio: c.size / N },
      });
    }

    const groundSample = [];
    for (let y = Math.min(H - 1, bottom + Math.round(bandH * 0.1)); y < H; y += 2) {
      for (let x = 0; x < W; x += 2) {
        const i = y * W + x;
        if (!green[i] && !sky[i]) groundSample.push(i);
      }
    }
    const groundColor = dominantColor(rgba, groundSample);
    const groundLab = rgbToLab(groundColor.r, groundColor.g, groundColor.b);
    const obstacleMask = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const y = (i / W) | 0;
      if (y < bottom + Math.round(bandH * 0.05)) continue;
      if (sky[i] || green[i]) continue;
      const s = hsl[i * 3 + 1], l = lab[i * 3];
      if (s < 0.28 || l < 26 || l > 90) continue;
      if (labDistance({ l, a: lab[i * 3 + 1], b: lab[i * 3 + 2] }, groundLab) < 18) continue;
      obstacleMask[i] = 1;
    }
    const obstacleComps = connectedComponents(obstacleMask, W, H, Math.max(2, Math.round(N * 0.002)));
    for (const c of obstacleComps) {
      if (c.size > N * 0.14) continue;
      const cm = new Uint8Array(N);
      fillComp(cm, c);
      objects.push({
        key: `obstacle-${objects.length + 1}`,
        className: 'obstacle',
        displayName: CLASS_META.obstacle.name,
        paintable: false,
        confidence: 0.35,
        mask: { width: W, height: H, alpha: cm },
        geometry: { bbox: { x: c.minX, y: c.minY, w: c.maxX - c.minX + 1, h: c.maxY - c.minY + 1 }, areaPx: c.size, areaRatio: c.size / N },
      });
    }

    for (const side of ['left', 'right']) {
      const atEdge = side === 'left' ? houseLeft > W * 0.12 : houseRight < W * 0.88;
      if (!atEdge) continue;
      const em = new Uint8Array(N);
      const band = Math.max(2, Math.round(W * 0.06));
      const xFrom = side === 'left' ? 0 : Math.min(W - 1, houseRight + 1);
      const xTo = side === 'left' ? Math.max(0, houseLeft - 1) : W - 1;
      for (let y = top; y <= bottom; y++) {
        for (let x = xFrom; x <= xTo; x++) {
          const i = y * W + x;
          if (!sky[i] && !green[i]) em[i] = 1;
        }
      }
      const eComps = connectedComponents(em, W, H, Math.max(3, Math.round(N * 0.01)));
      for (const c of eComps) {
        const cm = new Uint8Array(N);
        fillComp(cm, c);
        objects.push({
          key: `${side}-neighbor-${objects.length + 1}`,
          className: 'neighbor-house',
          displayName: CLASS_META['neighbor-house'].name,
          paintable: false,
          confidence: 0.5,
          mask: { width: W, height: H, alpha: cm },
          geometry: { bbox: { x: c.minX, y: c.minY, w: c.maxX - c.minX + 1, h: c.maxY - c.minY + 1 }, areaPx: c.size, areaRatio: c.size / N },
        });
      }
    }

    // --- Context colors (fixed, non-paintable reference palette) ----------
    const skyIdx = [];
    for (let i = 0; i < N; i++) if (sky[i]) skyIdx.push(i);
    const context = {
      skyColor: skyIdx.length ? medianColor(rgba, skyIdx) : null,
      groundColor,
      roofColor: hasRoof ? avgOf(roofMask) : null,
      wallColor,
      lighting: clamp(meanL(lab, structureIdx) / 128, 0.7, 1.3),
      palette: dominantPalette(rgba, N),
    };

    const house = {
      present,
      bbox: { x: houseLeft, y: top, w: bbox.w, h: bbox.h },
      confidence: present ? clamp(0.45 + areaRatio * 1.4, 0.3, 0.95) : 0,
      style: present ? guessStyle(bbox.w, bbox.h, roofRowCount / bandH) : 'unknown',
      material: present ? guessMaterial(wallColor) : 'unknown',
      color: wallColor,
    };

    return {
      scale: { width: W, height: H, factor: scale },
      house,
      surfaces,
      objects,
      context,
    };
  }

  return {
    scale: { width: W, height: H, factor: scale },
    house: { present: false, bbox: null, confidence: 0, style: 'unknown', material: 'unknown', color: null },
    surfaces,
    objects,
    context: {
      skyColor: null, groundColor: null, roofColor: null, wallColor: null,
      lighting: 1, palette: dominantPalette(rgba, N),
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers

function dominantColor(rgba, idx) {
  const buckets = new Map();
  const step = Math.max(1, Math.floor(idx.length / 20000));
  for (let k = 0; k < idx.length; k += step) {
    const o = idx[k] * 4;
    const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0 };
    e.r += r; e.g += g; e.b += b; e.n++;
    buckets.set(key, e);
  }
  let best = null;
  for (const e of buckets.values()) {
    if (!best || e.n > best.n) best = e;
  }
  if (!best) return { r: 128, g: 128, b: 128 };
  return { r: Math.round(best.r / best.n), g: Math.round(best.g / best.n), b: Math.round(best.b / best.n) };
}

function medianColor(rgba, idx) {
  const step = Math.max(1, Math.floor(idx.length / 20000));
  const rs = [], gs = [], bs = [];
  for (let k = 0; k < idx.length; k += step) {
    const o = idx[k] * 4;
    rs.push(rgba[o]); gs.push(rgba[o + 1]); bs.push(rgba[o + 2]);
  }
  if (!rs.length) return null;
  rs.sort((a, b) => a - b); gs.sort((a, b) => a - b); bs.sort((a, b) => a - b);
  const mid = rs.length >> 1;
  return { r: rs[mid], g: gs[mid], b: bs[mid] };
}

function dominantPalette(rgba, N) {
  const buckets = new Map();
  for (let i = 0; i < N; i += 3) {
    const o = i * 4;
    const key = ((rgba[o] >> 4) << 8) | ((rgba[o + 1] >> 4) << 4) | (rgba[o + 2] >> 4);
    const e = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0 };
    e.r += rgba[o]; e.g += rgba[o + 1]; e.b += rgba[o + 2]; e.n++;
    buckets.set(key, e);
  }
  return [...buckets.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, 5)
    .map((e) => ({ r: Math.round(e.r / e.n), g: Math.round(e.g / e.n), b: Math.round(e.b / e.n) }));
}

function meanL(lab, idx) {
  if (!idx.length) return 100;
  let sum = 0;
  const step = Math.max(1, Math.floor(idx.length / 20000));
  for (let k = 0; k < idx.length; k += step) sum += lab[idx[k] * 3];
  return sum / Math.max(1, Math.ceil(idx.length / step));
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

// BFS connected components; returns { id, size, bbox, pixels } for comps
// meeting minSize. `pixels` lets callers rebuild an exact component mask.
function connectedComponents(mask, W, H, minSize) {
  const visited = new Uint8Array(mask.length);
  const comps = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    const queue = new Int32Array(mask.length);
    let head = 0, tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    let size = 0, minX = W, minY = H, maxX = -1, maxY = -1;
    while (head < tail) {
      const i = queue[head++];
      size++;
      const x = i % W, y = (i / W) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const tryPush = (ni) => {
        if (mask[ni] && !visited[ni]) { visited[ni] = 1; queue[tail++] = ni; }
      };
      if (x > 0) tryPush(i - 1);
      if (x < W - 1) tryPush(i + 1);
      if (y > 0) tryPush(i - W);
      if (y < H - 1) tryPush(i + W);
    }
    if (size >= minSize) {
      const pixels = new Int32Array(size);
      for (let k = 0; k < size; k++) pixels[k] = queue[k];
      comps.push({ id: comps.length, size, minX, minY, maxX, maxY, pixels });
    }
  }
  return comps;
}

function fillComp(outMask, comp) {
  for (let k = 0; k < comp.pixels.length; k++) outMask[comp.pixels[k]] = 1;
}

// Square-structure dilate on a Uint8 boolean mask.
function dilate(mask, W, H, r) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!mask[i]) continue;
      const x0 = Math.max(0, x - r), x1 = Math.min(W - 1, x + r);
      const y0 = Math.max(0, y - r), y1 = Math.min(H - 1, y + r);
      for (let yy = y0; yy <= y1; yy++) {
        const base = yy * W;
        for (let xx = x0; xx <= x1; xx++) out[base + xx] = 1;
      }
    }
  }
  return out;
}

module.exports = { id: ID, version: VERSION, supports, run };
