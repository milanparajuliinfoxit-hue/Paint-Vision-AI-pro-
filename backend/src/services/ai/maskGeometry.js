/**
 * Shared boolean-mask geometry helpers for house-understanding providers.
 *
 * This is the same array-mask math the deleted local pipeline.py used
 * (recovered via `git show 8c2c675^:backend/vision-service/pipeline.py`,
 * see AI_HOSTED_ARCHITECTURE.md §2) — dilation, connected components,
 * dominant/median color extraction, style/material heuristics. It's pure
 * geometry over a boolean mask, independent of which model produced the
 * mask, so it's shared by any real house-understanding provider rather than
 * re-copied per provider.
 *
 * Convention: masks are Uint8Array booleans (0/1), row-major, size W*H. The
 * app's mask CONTRACT uses a 0-255 alpha "selection strength" (see
 * colorEngine.applyPaintColor) — only toAlpha255 crosses that boundary;
 * every other helper here stays in 0/1 booleans.
 */
const { rgbToHsl } = require('./color');

function toAlpha255(mask) {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] ? 255 : 0;
  return out;
}

function countOn(mask) {
  let c = 0;
  for (let i = 0; i < mask.length; i++) c += mask[i];
  return c;
}

function maskBbox(mask, W, H) {
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % W, y = (i / W) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (maxX < minX) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
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

// BFS connected components; returns { id, size, minX, minY, maxX, maxY, pixels }
// for components meeting minSize. `pixels` lets callers rebuild an exact mask.
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

function dominantPalette(rgba, N, n = 5) {
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
    .slice(0, n)
    .map((e) => ({ r: Math.round(e.r / e.n), g: Math.round(e.g / e.n), b: Math.round(e.b / e.n) }));
}

function guessStyle(w, h, roofFrac) {
  if (!h) return 'unknown';
  if (w / h > 1.35) return 'ranch';
  if (roofFrac > 0.12) return 'traditional';
  return 'modern';
}

function guessMaterial(wallColor) {
  if (!wallColor) return 'unknown';
  const { h, s, l } = rgbToHsl(wallColor.r, wallColor.g, wallColor.b);
  if (s > 0.22 && h >= 6 && h <= 48) return l < 0.45 ? 'brick' : 'wood';
  if (l > 0.6 && s < 0.16) return 'render';
  return 'unknown';
}

// Dominant/median color of the pixels where `mask` is truthy. `mask` is
// W*H booleans, `rgba` is the same image's W*H*4 pixel buffer.
function colorOfMask(rgba, mask) {
  const idx = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) idx.push(i);
  return dominantColor(rgba, idx);
}

function medianColorOfMask(rgba, mask) {
  const idx = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) idx.push(i);
  return idx.length ? medianColor(rgba, idx) : null;
}

module.exports = {
  toAlpha255, countOn, maskBbox, dilate, connectedComponents, fillComp,
  dominantColor, medianColor, dominantPalette, guessStyle, guessMaterial,
  colorOfMask, medianColorOfMask,
};
