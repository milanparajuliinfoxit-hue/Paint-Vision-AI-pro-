// Pure mask-rasterization helpers — each returns an ImageData whose alpha
// channel is the selection strength (0-255), same contract colorEngine.js
// already expects. No Konva/DOM coupling here so these stay unit-testable.

export function createEmptyMask(width, height) {
  return new ImageData(width, height);
}

// Clips a mask's alpha to a constraint grid (e.g. an AI-detected surface
// mask): paint cannot escape the constrained region. `constraintAlpha` is a
// Uint8Array of length width*height; pixels outside it keep only their
// intersection with the constraint, so feathered edges fade against the
// surface boundary instead of hard-clipping.
export function clipMaskToConstraint(mask, constraintAlpha) {
  if (!constraintAlpha || constraintAlpha.length !== mask.width * mask.height) return mask;
  const out = new ImageData(mask.width, mask.height);
  out.data.set(mask.data);
  for (let i = 0; i < mask.data.length; i += 4) {
    const c = constraintAlpha[i / 4] || 0;
    if (out.data[i + 3] > c) out.data[i + 3] = c;
  }
  return out;
}

// Blurs just the alpha channel via a canvas blur filter, tapering a hard
// 0/255 edge into a soft falloff a few pixels wide so painted regions blend
// into the surrounding wall texture instead of cutting out like a sticker.
// RGB channels are irrelevant downstream (colorEngine only reads alpha), so
// blurring them along with alpha is harmless.
export function featherMask(mask, radiusPx) {
  if (!radiusPx) return mask;
  const src = document.createElement('canvas');
  src.width = mask.width;
  src.height = mask.height;
  src.getContext('2d').putImageData(mask, 0, 0);

  const out = document.createElement('canvas');
  out.width = mask.width;
  out.height = mask.height;
  const octx = out.getContext('2d');
  octx.filter = `blur(${radiusPx}px)`;
  octx.drawImage(src, 0, 0);
  return octx.getImageData(0, 0, mask.width, mask.height);
}

export function rasterizeRect(width, height, x0, y0, x1, y1) {
  const mask = new ImageData(width, height);
  const left = Math.max(0, Math.round(Math.min(x0, x1)));
  const right = Math.min(width, Math.round(Math.max(x0, x1)));
  const top = Math.max(0, Math.round(Math.min(y0, y1)));
  const bottom = Math.min(height, Math.round(Math.max(y0, y1)));

  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      mask.data[(y * width + x) * 4 + 3] = 255;
    }
  }
  return featherMask(mask, 2);
}

// points: [{x,y}, ...] — even-odd polygon fill via a scratch canvas (the
// browser's own rasterizer is both simpler and more correct than a hand
// rolled scanline fill).
export function rasterizePolygon(width, height, points) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  ctx.fill();
  return featherMask(ctx.getImageData(0, 0, width, height), 2);
}

// Inserts linearly-interpolated points wherever consecutive recorded points
// are farther apart than maxSpacing. Pointer-move events thin out during a
// fast mouse flick, and a stroke drawn straight between sparse points shows
// visible corners at every direction change — resampling keeps the input
// dense enough for the curve smoothing below to actually read as a curve.
function resamplePoints(points, maxSpacing) {
  if (points.length < 2) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.floor(dist / maxSpacing);
    for (let s = 1; s <= steps; s++) {
      const t = s / (steps + 1);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    out.push(b);
  }
  return out;
}

// Draws a smooth curve through `points` by quadratic-curving to the midpoint
// of each consecutive pair — the standard freehand-smoothing trick. This
// removes the sharp polyline corners a raw moveTo/lineTo chain leaves behind
// on quick strokes, without needing a spline library.
function strokeSmoothPath(ctx, points) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  if (points.length < 3) {
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  } else {
    for (let i = 1; i < points.length - 1; i++) {
      const curr = points[i];
      const next = points[i + 1];
      const mid = { x: (curr.x + next.x) / 2, y: (curr.y + next.y) / 2 };
      ctx.quadraticCurveTo(curr.x, curr.y, mid.x, mid.y);
    }
    const last = points[points.length - 1];
    ctx.lineTo(last.x, last.y);
  }
  ctx.stroke();
}

// A brush stroke is a smoothed, resampled path stroked with a round pen —
// feathered afterward so the paint tapers into the surrounding surface
// instead of leaving a hard-edged decal. `opts.feather` can be 0 to get the
// raw footprint (used by the surface-aware brush, which clips the footprint
// against the image before applying its own edge).
export function rasterizeBrushStroke(width, height, points, brushSize, opts = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.strokeStyle = 'white';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = brushSize;

  const dense = resamplePoints(points, Math.max(2, brushSize / 4));
  strokeSmoothPath(ctx, dense);

  // Round caps at both ends of the smoothed path (quadraticCurveTo can pull
  // the very first/last segment slightly short of the recorded point).
  dense.forEach((p) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, brushSize / 2, 0, Math.PI * 2);
    ctx.fill();
  });

  const feather = opts.feather === 0 ? 0 : Math.min(6, Math.max(1.5, brushSize * 0.08));
  return featherMask(ctx.getImageData(0, 0, width, height), feather);
}

// --- Surface-aware brush ---------------------------------------------------
// A region-growing "smart brush". The plain rasterizer above paints every
// pixel its stamps touch; this variant clips that footprint to the
// architectural surface under the stroke using the base image itself:
//
//   1. The stroke is rasterized as usual — the brush swath (footprint).
//   2. Each resampled brush point samples the local surface color (the
//      median of a small window, robust to the window straddling an edge).
//      Points whose own window reads "off-surface" (the brush centre sat on
//      a railing/frame/glass) are dropped as seeds.
//   3. A flood fill grows out of the surviving seeds, but only into pixels
//      that are (a) inside the brush swath and (b) perceptually close (LAB)
//      to the *local* surface color interpolated from the seed samples.
//
// The fill cannot cross a strong boundary — a window frame, railing, sky or
// ground seam is far in LAB from the wall — and it cannot jump a gap either,
// because it only flows through in-tolerance, in-swath pixels. A stroke that
// passes over a railing therefore stops on the wall side instead of bleeding
// through to the wall behind it. Walls with gradual shading stay continuous
// because each region is compared against its own nearby surface sample, not
// one global color.
export function surfaceAwareBrushStroke(baseImageData, width, height, points, brushSize, tolerance, rgbToLab) {
  const raw = rasterizeBrushStroke(width, height, points, brushSize, { feather: 0 });

  // Stroke bounding box, padded so the fill can also reach pixels the
  // antialiased footprint left just below full alpha and so the final
  // feather has room to fall off. The whole pass stays local to this box.
  const pad = Math.ceil(brushSize);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (const p of points) {
    minX = Math.min(minX, Math.floor(p.x));
    minY = Math.min(minY, Math.floor(p.y));
    maxX = Math.max(maxX, Math.ceil(p.x));
    maxY = Math.max(maxY, Math.ceil(p.y));
  }
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  if (maxX < minX || maxY < minY) return createEmptyMask(width, height);

  const bd = baseImageData.data;
  const dense = resamplePoints(points, Math.max(2, brushSize / 4));
  const win = Math.max(2, Math.min(6, Math.round(brushSize / 6)));
  const toleranceSq = tolerance * tolerance;

  // Per-seed local surface color + acceptance (only on-surface seeds may
  // seed the fill or feed the reference field — otherwise a railing-colored
  // sample would poison the tolerance test for nearby wall pixels).
  const seeds = [];
  for (const p of dense) {
    const sx = Math.min(width - 1, Math.max(0, Math.round(p.x)));
    const sy = Math.min(height - 1, Math.max(0, Math.round(p.y)));
    const ref = sampleWindowLab(bd, width, height, sx, sy, win, rgbToLab);
    if (!ref) continue;
    const seedIdx = (sy * width + sx) * 4;
    const seedLab = rgbToLab(bd[seedIdx], bd[seedIdx + 1], bd[seedIdx + 2]);
    if (labDistSq(seedLab, ref) > toleranceSq) continue;
    seeds.push({ x: sx, y: sy, ref });
  }
  if (seeds.length === 0) return createEmptyMask(width, height);

  // Coarse reference field over the stroke box: each grid cell takes the
  // surface color of its nearest surviving seed, so the reference used for
  // the tolerance test tracks the local wall shading instead of snapping
  // between nearby seed samples.
  const CELL = 24;
  const originX = Math.floor(minX / CELL) * CELL;
  const originY = Math.floor(minY / CELL) * CELL;
  const gw = Math.ceil((maxX - originX + 1) / CELL);
  const gh = Math.ceil((maxY - originY + 1) / CELL);
  const grid = new Float64Array(gw * gh * 3);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const cx = Math.min(maxX, originX + gx * CELL + CELL / 2);
      const cy = Math.min(maxY, originY + gy * CELL + CELL / 2);
      let best = -1, bestD = Infinity;
      for (let s = 0; s < seeds.length; s++) {
        const dx = seeds[s].x - cx, dy = seeds[s].y - cy;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = s; }
      }
      const o = (gy * gw + gx) * 3;
      grid[o] = seeds[best].ref.l;
      grid[o + 1] = seeds[best].ref.a;
      grid[o + 2] = seeds[best].ref.b;
    }
  }

  // BFS flood fill confined to the swath, gated by the interpolated surface
  // reference. `out` accumulates the result alpha directly on a Uint8 grid
  // and is wrapped into an ImageData once the fill settles.
  const rawData = raw.data;
  const out = new Uint8Array(width * height);
  const visited = new Uint8Array(width * height);
  const queue = [];
  let qHead = 0;
  for (const s of seeds) {
    const idx = s.y * width + s.x;
    if (!visited[idx]) { visited[idx] = 1; queue.push(idx); }
  }
  while (qHead < queue.length) {
    const idx = queue[qHead++];
    out[idx] = 255;
    const x = idx % width;
    const y = (idx / width) | 0;

    const tryEnter = (nIdx) => {
      if (visited[nIdx] || rawData[nIdx * 4 + 3] === 0) return;
      const nx = nIdx % width;
      const ny = (nIdx / width) | 0;
      const gx = Math.min(gw - 1, Math.max(0, ((nx - originX) / CELL) | 0));
      const gy = Math.min(gh - 1, Math.max(0, ((ny - originY) / CELL) | 0));
      const o = (gy * gw + gx) * 3;
      const lab = rgbToLab(bd[nIdx * 4], bd[nIdx * 4 + 1], bd[nIdx * 4 + 2]);
      const dl = lab.l - grid[o], da = lab.a - grid[o + 1], db = lab.b - grid[o + 2];
      if (dl * dl + da * da + db * db > toleranceSq) return;
      visited[nIdx] = 1;
      queue.push(nIdx);
    };

    if (x > 0) tryEnter(idx - 1);
    if (x < width - 1) tryEnter(idx + 1);
    if (y > 0) tryEnter(idx - width);
    if (y < height - 1) tryEnter(idx + width);
  }

  const mask = new ImageData(width, height);
  const mdata = mask.data;
  for (let i = 0; i < out.length; i++) mdata[i * 4 + 3] = out[i];

  const feather = Math.min(6, Math.max(1.5, brushSize * 0.08));
  return featherMask(mask, feather);
}

// Median of the LAB colors in a small window around (cx, cy). The median is
// robust to the window straddling an edge — a half-wall/half-frame window
// still reads as wall, where the mean would be dragged off toward the frame.
function sampleWindowLab(data, width, height, cx, cy, r, rgbToLab) {
  const labs = [];
  for (let y = cy - r; y <= cy + r; y++) {
    if (y < 0 || y >= height) continue;
    const row = y * width;
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || x >= width) continue;
      const i = (row + x) * 4;
      labs.push(rgbToLab(data[i], data[i + 1], data[i + 2]));
    }
  }
  if (labs.length === 0) return null;
  return { l: medianChannel(labs, 'l'), a: medianChannel(labs, 'a'), b: medianChannel(labs, 'b') };
}

function medianChannel(labs, key) {
  const arr = new Float64Array(labs.length);
  for (let i = 0; i < labs.length; i++) arr[i] = labs[i][key];
  arr.sort();
  return arr[(arr.length / 2) | 0];
}

function labDistSq(a, b) {
  const dl = a.l - b.l, da = a.a - b.a, db = a.b - b.b;
  return dl * dl + da * da + db * db;
}

// Merges a stroke/selection into an existing mask — 'add' (union, default)
// or 'subtract' (for brush mask-edit mode's alt-key erase / eraser tool per
// Section 5.2). Subtract reduces alpha proportionally rather than zeroing it
// out wherever the stroke touches, so erasing across a feathered edge fades
// it smoothly instead of punching a hard binary hole.
export function mergeMasks(baseMask, strokeMask, mode = 'add') {
  const out = new ImageData(baseMask.width, baseMask.height);
  out.data.set(baseMask.data);
  for (let i = 3; i < out.data.length; i += 4) {
    if (mode === 'subtract') {
      out.data[i] = Math.max(0, out.data[i] - strokeMask.data[i]);
    } else {
      out.data[i] = Math.max(out.data[i], strokeMask.data[i]);
    }
  }
  return out;
}

// Near-zero, not exact-zero: an eraser stroke is rasterized on a real
// <canvas> (rasterizeBrushStroke), and canvas fill/stroke operations
// anti-alias their own geometric edges — a sub-pixel coverage artifact
// independent of this app's own deliberate feathering (which the eraser
// already disables via { feather: 0 } — see useToolInteraction.js — for
// exactly this reason: without it, a *soft* stroke edge could never
// subtract a layer's alpha down to true zero no matter how thoroughly the
// user erased). ALPHA_FLOOR absorbs that native rendering noise without
// weakening the check for a layer that still has real, visible paint —
// 3/255 is ~1%, far below anything a user could perceive as "still
// painted," and far below the alpha a stroke leaves on any pixel it didn't
// genuinely cover.
const ALPHA_FLOOR = 3;
export function isMaskEmpty(mask) {
  for (let i = 3; i < mask.data.length; i += 4) {
    if (mask.data[i] > ALPHA_FLOOR) return false;
  }
  return true;
}

// Whether two same-size masks have any pixel where both have paint —
// the eraser's canvas-hit-test: "does this layer actually have something
// under the stroke," not just "is the stroke's bounding box near it."
export function masksOverlap(maskA, maskB) {
  for (let i = 3; i < maskA.data.length; i += 4) {
    if (maskA.data[i] > 0 && maskB.data[i] > 0) return true;
  }
  return false;
}

// Per-pixel max across multiple same-size alpha grids — builds a single
// "house protection" region out of every detected surface's own mask
// (paintable or not: a window/door is still part of the house), regardless
// of how many separate surfaces the house was split into. Pure/DOM-free so
// it's unit-testable; the actual per-surface grids come from AI-detected
// masks loaded via loadAlphaGrid (useHouseProtectionAlpha).
export function unionAlphaGrids(grids) {
  const real = (grids || []).filter(Boolean);
  if (real.length === 0) return null;
  const union = new Uint8Array(real[0].length);
  for (const grid of real) {
    for (let i = 0; i < union.length; i++) {
      if (grid[i] > union[i]) union[i] = grid[i];
    }
  }
  return union;
}

// Whether (x, y) falls solidly inside an alpha grid — used to validate a
// Magic Wand click actually landed on the detected house before selecting
// anything at all (requirements: reject a click outside the house region
// instead of creating an empty/stray paint layer). Threshold defaults high
// (128 of 255): a *click* should land solidly on a detected surface, not
// merely brush its soft feathered edge — contrast with the looser threshold
// floodFillMask itself uses while spreading (see houseAlphaThreshold below).
export function isPointInsideAlpha(alpha, width, height, x, y, threshold = 128) {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= width || iy >= height) return false;
  return alpha[iy * width + ix] >= threshold;
}

// Pure predicate: should the Magic Wand's flood fill cross into this
// neighbor pixel? DOM/Canvas-free (unlike floodFillMask itself, which needs
// a real ImageData/canvas to feather its result) so this — the actual
// house-aware decision — is unit-testable under plain Node.
//
// Three independent gates, all of which must pass:
//  1. houseAlphaValue: if a detected house-region grid is available, a
//     pixel outside it (below houseAlphaThreshold) can NEVER be entered,
//     no matter how close its color is — this is what stops a click on a
//     blue house wall from spreading into color-similar blue sky, which a
//     color-tolerance-only flood fill cannot tell apart on its own.
//  2. distFromSeed: the existing global color-tolerance check against the
//     originally clicked pixel.
//  3. step: the LAB distance from the pixel the fill is entering *from* —
//     tighter than the seed tolerance. A real boundary (roofline against
//     sky, wall against ground) shows a bigger jump between two adjacent
//     pixels than the gradual internal shading of one surface does, even
//     when both sides individually fall within the same broad tolerance of
//     the clicked pixel — this is the "boundary-aware" half of the fill,
//     and the only protection available at all when no house mask exists.
export function canEnterFloodFillPixel({ neighborLab, seedLab, fromLab, tolerance, stepTolerance, houseAlphaValue, houseAlphaThreshold = 32 }) {
  if (houseAlphaValue !== undefined && houseAlphaValue !== null && houseAlphaValue < houseAlphaThreshold) return false;
  const distFromSeed = Math.sqrt((neighborLab.l - seedLab.l) ** 2 + (neighborLab.a - seedLab.a) ** 2 + (neighborLab.b - seedLab.b) ** 2);
  if (distFromSeed > tolerance) return false;
  const step = Math.sqrt((neighborLab.l - fromLab.l) ** 2 + (neighborLab.a - fromLab.a) ** 2 + (neighborLab.b - fromLab.b) ** 2);
  if (step > stepTolerance) return false;
  return true;
}

// Count of pixels with any paint (alpha > 0) — used for Magic Wand
// selection-size logging, not a rendering concern.
export function countMaskPixels(mask) {
  let count = 0;
  for (let i = 3; i < mask.data.length; i += 4) {
    if (mask.data[i] > 0) count++;
  }
  return count;
}

// Fills small isolated gaps left inside an otherwise-selected region — the
// fix for the "patches of original paint remaining" defect. A strict
// connectivity flood fill permanently rejects any pixel that fails the
// tolerance test the moment it's first reached, so ordinary photo noise
// (JPEG block artifacts, texture grain, a fleck of dust, a faint stain)
// scattered across a real wall leaves a scatter of unselected single-pixel
// holes. This is not the same problem as "tolerance is too low": those
// pixels are surrounded on (almost) every side by pixels the fill *did*
// accept, so simply raising tolerance to catch them would also catch
// genuinely different surfaces elsewhere in the image.
//
// A pixel is only re-admitted if BOTH hold:
//   1. Neighbor-majority: at least `minNeighbors` of its 8 neighbors are
//      already selected — true for an isolated speck inside a selection,
//      false for a real unselected region (a window is a large contiguous
//      blob; the vast majority of its own border pixels border *other
//      window pixels*, not selected wall pixels) so this cannot bridge into
//      an architectural feature no matter how many iterations run.
//   2. Color plausibility: still within a loosened multiple of the seed
//      tolerance — a truly odd pixel (a screw head, a small crack) stays
//      excluded even when fully surrounded by selection.
function fillHolesPass(grid, width, height, data, refLab, rgbToLab, toleranceLoose, minNeighbors) {
  const out = Uint8Array.from(grid);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (grid[idx] !== 0) continue; // only ever fills gaps, never shrinks the selection
      let selected = 0;
      let total = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          total++;
          if (grid[ny * width + nx] !== 0) selected++;
        }
      }
      if (total === 0 || selected < minNeighbors) continue;
      const i = idx * 4;
      const lab = rgbToLab(data[i], data[i + 1], data[i + 2]);
      const dist = Math.sqrt((lab.l - refLab.l) ** 2 + (lab.a - refLab.a) ** 2 + (lab.b - refLab.b) ** 2);
      if (dist <= toleranceLoose) out[idx] = 255;
    }
  }
  return out;
}

// Runs fillHolesPass a few times so a 2-3px noise cluster (not just single
// pixels) closes too, without ever touching a pixel that isn't tightly
// surrounded by real selection.
export function closeSmallHoles(rawGrid, width, height, data, refLab, rgbToLab, tolerance, opts = {}) {
  const { iterations = 3, minNeighbors = 6, toleranceMultiplier = 1.6 } = opts;
  let grid = rawGrid;
  const toleranceLoose = tolerance * toleranceMultiplier;
  for (let it = 0; it < iterations; it++) {
    grid = fillHolesPass(grid, width, height, data, refLab, rgbToLab, toleranceLoose, minNeighbors);
  }
  return grid;
}

function gridToImageData(grid, width, height) {
  const mask = new ImageData(width, height);
  for (let i = 0; i < grid.length; i++) mask.data[i * 4 + 3] = grid[i];
  return mask;
}

// The connectivity-respecting BFS core of the Magic Wand, factored out so it
// can be exercised directly by tests (pure Uint8Array grids, no Canvas/DOM)
// and shared between floodFillMask and floodFillMaskDebug. Boundary-aware
// (see canEnterFloodFillPixel): gated by color distance from the clicked
// pixel, the local step between adjacent pixels, and — when `opts.houseAlpha`
// (a detected-house-region grid) is available — never crosses outside it,
// however close the colors are on either side. Returns both the raw
// fill result and the hole-closed result so callers/tests can inspect either
// stage.
export function computeFloodFillGrids(imageData, startX, startY, tolerance, rgbToLab, opts = {}) {
  const { houseAlpha, houseAlphaThreshold = 32, closeHoles = true } = opts;
  const { width, height, data } = imageData;
  const rawGrid = new Uint8Array(width * height);
  const visited = new Uint8Array(width * height);
  // A real edge shows a bigger jump between two adjacent pixels than the
  // gradual shading inside one surface does — capped well below the overall
  // seed tolerance so raising the color-similarity slider doesn't also loosen
  // the boundary barrier.
  const stepTolerance = Math.min(tolerance, 14);

  const startIdx = (startY * width + startX) * 4;
  const startLab = rgbToLab(data[startIdx], data[startIdx + 1], data[startIdx + 2]);

  const stack = [[startX, startY, startLab]];
  visited[startY * width + startX] = 1;

  while (stack.length) {
    const [x, y, fromLab] = stack.pop();
    rawGrid[y * width + x] = 255;

    const neighbors = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const nIdx = ny * width + nx;
      if (visited[nIdx]) continue;
      visited[nIdx] = 1; // mark on first discovery so each pixel is evaluated exactly once
      const ni = nIdx * 4;
      const neighborLab = rgbToLab(data[ni], data[ni + 1], data[ni + 2]);
      const canEnter = canEnterFloodFillPixel({
        neighborLab,
        seedLab: startLab,
        fromLab,
        tolerance,
        stepTolerance,
        houseAlphaValue: houseAlpha ? houseAlpha[nIdx] : undefined,
        houseAlphaThreshold,
      });
      if (!canEnter) continue;
      stack.push([nx, ny, neighborLab]);
    }
  }

  let closedGrid = rawGrid;
  if (closeHoles) {
    closedGrid = closeSmallHoles(rawGrid, width, height, data, startLab, rgbToLab, tolerance);
    // Hole-closing must never let paint escape a detected house region, even
    // though it already can't bridge into a real architectural feature on
    // its own (see fillHolesPass) — this is a cheap, redundant belt-and-
    // braces clip against the same outer boundary the fill itself respects.
    if (houseAlpha) {
      for (let i = 0; i < closedGrid.length; i++) {
        if (houseAlpha[i] < houseAlphaThreshold && closedGrid[i] !== rawGrid[i]) closedGrid[i] = rawGrid[i];
      }
    }
  }

  return { width, height, rawGrid, closedGrid };
}

// Flood-fill by LAB color distance from a clicked pixel — the "Magic Wand"
// tool, pure client-side, no segmentation model (requirements doc, Section
// 5.2 flags real AI surface segmentation as a separate, deferred feature).
export function floodFillMask(imageData, startX, startY, tolerance, rgbToLab, opts = {}) {
  const { closedGrid, width, height } = computeFloodFillGrids(imageData, startX, startY, tolerance, rgbToLab, opts);
  const mask = gridToImageData(closedGrid, width, height);
  return featherMask(mask, opts.featherPx ?? 1.5);
}

// Debug variant (Magic Wand debug mode — AdjustmentsTab): returns every
// stage of the pipeline as its own alpha-only ImageData so a caller can
// render "raw selection" vs "after hole-closing" vs "final feathered mask"
// side by side, instead of only ever seeing the end result.
export function floodFillMaskDebug(imageData, startX, startY, tolerance, rgbToLab, opts = {}) {
  const { rawGrid, closedGrid, width, height } = computeFloodFillGrids(imageData, startX, startY, tolerance, rgbToLab, opts);
  const raw = gridToImageData(rawGrid, width, height);
  const closed = gridToImageData(closedGrid, width, height);
  const final = featherMask(gridToImageData(closedGrid, width, height), opts.featherPx ?? 1.5);
  return { mask: final, raw, closed, final };
}

// Renders an alpha-only mask ImageData as a visible black/white PNG data URL
// (alpha value -> grayscale RGB, full opacity) so it can be shown directly
// in an <img> — used only by the Magic Wand debug panel.
export function maskToPreviewDataUrl(mask) {
  const canvas = document.createElement('canvas');
  canvas.width = mask.width;
  canvas.height = mask.height;
  const ctx = canvas.getContext('2d');
  const vis = ctx.createImageData(mask.width, mask.height);
  for (let i = 0; i < mask.data.length; i += 4) {
    const v = mask.data[i + 3];
    vis.data[i] = v; vis.data[i + 1] = v; vis.data[i + 2] = v; vis.data[i + 3] = 255;
  }
  ctx.putImageData(vis, 0, 0);
  return canvas.toDataURL('image/png');
}

export function imageDataToPngBlob(imageData) {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext('2d').putImageData(imageData, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

// Hit-tests a pointer against the AI-detected surface masks and returns the
// topmost paintable surface whose alpha at that pixel is above `threshold`
// (default: fully inside the mask). `surfaceMasks` is an array of
// { surface, alpha } where alpha is the upscaled Uint8Array grid from
// useSurfaceAlphaGrids. Order matters: later entries are "on top" (the same
// stacking the layer pipeline uses), so the first hit wins.
export function pickSurfaceAtPoint(surfaceMasks, x, y, threshold = 128) {
  const ix = Math.round(x);
  const iy = Math.round(y);
  for (const entry of surfaceMasks || []) {
    const { surface, alpha, width, height } = entry;
    if (!alpha || !surface?.paintable) continue;
    if (ix < 0 || iy < 0 || ix >= width || iy >= height) continue;
    if (alpha[iy * width + ix] > threshold) return surface;
  }
  return null;
}
