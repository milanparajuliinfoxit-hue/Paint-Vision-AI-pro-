// Pure mask-rasterization helpers — each returns an ImageData whose alpha
// channel is the selection strength (0-255), same contract colorEngine.js
// already expects. No Konva/DOM coupling here so these stay unit-testable.

export function createEmptyMask(width, height) {
  return new ImageData(width, height);
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

// Flood-fill by LAB color distance from a clicked pixel — the "Magic Wand"
// tool, pure client-side, no segmentation model (requirements doc, Section
// 5.2 flags real AI surface segmentation as a separate, deferred feature).
export function floodFillMask(imageData, startX, startY, tolerance, rgbToLab) {
  const { width, height, data } = imageData;
  const mask = new ImageData(width, height);
  const visited = new Uint8Array(width * height);

  const startIdx = (startY * width + startX) * 4;
  const startLab = rgbToLab(data[startIdx], data[startIdx + 1], data[startIdx + 2]);

  const stack = [[startX, startY]];
  visited[startY * width + startX] = 1;

  while (stack.length) {
    const [x, y] = stack.pop();
    const i = (y * width + x) * 4;
    const lab = rgbToLab(data[i], data[i + 1], data[i + 2]);
    const dist = Math.sqrt((lab.l - startLab.l) ** 2 + (lab.a - startLab.a) ** 2 + (lab.b - startLab.b) ** 2);
    if (dist > tolerance) continue;

    mask.data[i + 3] = 255;

    const neighbors = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const nIdx = ny * width + nx;
      if (visited[nIdx]) continue;
      visited[nIdx] = 1;
      stack.push([nx, ny]);
    }
  }
  return featherMask(mask, 1.5);
}

export function imageDataToPngBlob(imageData) {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext('2d').putImageData(imageData, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
