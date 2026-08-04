// Shared mask-image loading. All AI/layer masks are alpha PNGs on disk served
// via assets.fileUrl(...); every consumer (brush constraints, layer apply,
// scheme previews) needs the same read-draw-resample path. Centralizing it
// here keeps the pixel handling in one place (previously duplicated across
// useAiAnalysis.js / useApplySurface.js / VisualizerWorkspace.jsx).

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image failed to load'));
    img.src = url;
  });
}

// Draws a mask image up to width x height and returns its full ImageData —
// used as the merge base for brush mask edits.
export async function loadMaskImageData(url, width, height) {
  const img = await loadImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

// The alpha channel only, flattened to a Uint8Array of length width*height —
// used as the brush constraint (surface lock) and for hit-testing surfaces.
export async function loadAlphaGrid(url, width, height) {
  const data = (await loadMaskImageData(url, width, height)).data;
  const grid = new Uint8Array(width * height);
  for (let i = 0; i < grid.length; i++) grid[i] = data[i * 4 + 3];
  return grid;
}

// Draws a mask image up to width x height and encodes it as a PNG blob —
// the exact format the layers API stores (server saves the uploaded buffer).
export async function surfaceMaskToPngBlob(url, width, height) {
  const img = await loadImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, width, height);
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Mask encoding failed'))), 'image/png')
  );
  return blob;
}
