// Pure mask-rasterization helpers — each returns an ImageData whose alpha
// channel is the selection strength (0-255), same contract colorEngine.js
// already expects. No Konva/DOM coupling here so these stay unit-testable.

export function createEmptyMask(width, height) {
  return new ImageData(width, height);
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
  return mask;
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
  return ctx.getImageData(0, 0, width, height);
}

// A brush stroke is just a polygon-of-circles — reuse the same canvas
// rasterizer, drawing a filled circle at every recorded point.
export function rasterizeBrushStroke(width, height, points, brushSize) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'white';
  ctx.lineWidth = brushSize;
  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.stroke();
  points.forEach((p) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, brushSize / 2, 0, Math.PI * 2);
    ctx.fill();
  });
  return ctx.getImageData(0, 0, width, height);
}

// Merges a stroke/selection into an existing mask — 'add' (union, default)
// or 'subtract' (for brush mask-edit mode's alt-key erase per Section 5.2).
export function mergeMasks(baseMask, strokeMask, mode = 'add') {
  const out = new ImageData(baseMask.width, baseMask.height);
  out.data.set(baseMask.data);
  for (let i = 3; i < out.data.length; i += 4) {
    if (mode === 'subtract') {
      if (strokeMask.data[i] > 0) out.data[i] = 0;
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
  return mask;
}

export function imageDataToPngBlob(imageData) {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext('2d').putImageData(imageData, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
