// Scratch-canvas plumbing shared by the visualizer, export and suggestion
// paths — all of them need the same "draw something at width x height, read
// the pixels back" cycle.

export function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

// A canvas holding exactly these pixels — Konva Image nodes and blob/data-URL
// encoding both take a canvas, not an ImageData.
export function canvasFromImageData(imageData) {
  const canvas = createCanvas(imageData.width, imageData.height);
  canvas.getContext('2d').putImageData(imageData, 0, 0);
  return canvas;
}

// Rasterizes any drawable (image element, canvas) into ImageData, scaling it
// to the working resolution the callers already agreed on.
export function drawToImageData(source, width, height) {
  const ctx = createCanvas(width, height).getContext('2d');
  ctx.drawImage(source, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image failed to load'));
    img.src = src;
  });
}

// Masks are fetched as PNGs but consumed as alpha pixel data.
export async function loadImageData(src, width, height) {
  return drawToImageData(await loadImage(src), width, height);
}

export function canvasToPngBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
