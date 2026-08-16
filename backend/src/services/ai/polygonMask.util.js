/**
 * Polygon-contour -> raster alpha mask conversion.
 *
 * Gemini's documented segmentation output (ai.google.dev/gemini-api/docs/
 * image-understanding) returns each detected item's mask as a polygon
 * contour of [x,y] points normalized to 0-1000 — not a base64 alpha PNG the
 * way every other provider in this app (fal-vision, replicate-vision,
 * mockProvider) does. Every existing mask consumer (detected_surfaces.mask_path,
 * layers.mask_path, maskOps.js) expects a per-pixel alpha Uint8Array, so this
 * is the one piece of new glue geminiVisionProvider.js needs that no
 * existing provider required. Not validated against a live Gemini response
 * yet — the fill algorithm and normalization math are correct for the
 * *documented* schema; Phase 1's real call is what confirms the schema
 * itself.
 */

// Converts a Gemini box_2d (normalized 0-1000) to pixel-space {x0,y0,x1,y1}.
//
// CONFIRMED AGAINST A REAL LIVE CALL (2026-08-11, gemini-3.6-flash) that the
// actual field order is [x0, y0, x1, y1] — NOT [ymin, xmin, ymax, xmax] as
// ai.google.dev's own prose describes. Verified by cross-checking box_2d
// against the same detection's `mask` polygon points (which are
// unambiguously [x,y]): e.g. a real "pillar" detection returned
// box_2d=[583,537,822,563] with mask x-values in {583,822} and y-values in
// {537,563} — i.e. box_2d[0]/[2] are the x-range and [1]/[3] are the
// y-range, for every detection in that response, not just one. This is
// exactly the documented-vs-actual gap the project's "no fake success"
// rule exists to catch — the code now matches the real API, not the docs.
function box2dToPixels(box2d, width, height) {
  if (!Array.isArray(box2d) || box2d.length !== 4) return null;
  const [x0, y0, x1, y1] = box2d.map(Number);
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
  return {
    x0: Math.round((x0 / 1000) * width),
    y0: Math.round((y0 / 1000) * height),
    x1: Math.round((x1 / 1000) * width),
    y1: Math.round((y1 / 1000) * height),
  };
}

// Converts a Gemini polygon mask ([[x,y], ...] normalized 0-1000) to
// pixel-space points. Points are the outer image coordinate system already
// (not relative to a box crop) per the documented schema.
function polygonToPixels(points, width, height) {
  if (!Array.isArray(points)) return null;
  const px = points
    .map((p) => (Array.isArray(p) && p.length === 2 ? [Number(p[0]), Number(p[1])] : null))
    .filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (px.length < 3) return null;
  return px.map(([x, y]) => [(x / 1000) * width, (y / 1000) * height]);
}

// Even-odd scanline polygon fill — standard point-in-polygon rasterization,
// same category of algorithm maskGeometry.js/maskOps.js already use for
// hand-drawn polygon-tool masks, applied here to an API-returned contour
// instead of a user-drawn one.
function rasterizePolygon(pointsPx, width, height) {
  const mask = new Uint8Array(width * height);
  if (!pointsPx || pointsPx.length < 3) return mask;

  let yMin = Infinity, yMax = -Infinity;
  for (const [, y] of pointsPx) {
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  yMin = Math.max(0, Math.floor(yMin));
  yMax = Math.min(height - 1, Math.ceil(yMax));

  for (let y = yMin; y <= yMax; y++) {
    const scanY = y + 0.5;
    const xIntersections = [];
    for (let i = 0; i < pointsPx.length; i++) {
      const [x1, y1] = pointsPx[i];
      const [x2, y2] = pointsPx[(i + 1) % pointsPx.length];
      if ((y1 <= scanY && y2 > scanY) || (y2 <= scanY && y1 > scanY)) {
        const t = (scanY - y1) / (y2 - y1);
        xIntersections.push(x1 + t * (x2 - x1));
      }
    }
    xIntersections.sort((a, b) => a - b);
    const base = y * width;
    for (let i = 0; i + 1 < xIntersections.length; i += 2) {
      const xStart = Math.max(0, Math.round(xIntersections[i]));
      const xEnd = Math.min(width - 1, Math.round(xIntersections[i + 1]) - 1);
      for (let x = xStart; x <= xEnd; x++) mask[base + x] = 1;
    }
  }
  return mask;
}

// Fallback for when a detection has a box but no usable polygon — fills the
// bounding box, mirroring falVisionProvider.js's own bbox-fallback
// convention (rasterizeBoxes) so a degraded-but-visible mask is always
// preferred over silently dropping the detection.
function rasterizeBox(box, width, height) {
  const mask = new Uint8Array(width * height);
  if (!box) return mask;
  const x0 = Math.max(0, Math.min(width - 1, box.x0));
  const x1 = Math.max(0, Math.min(width - 1, box.x1));
  const y0 = Math.max(0, Math.min(height - 1, box.y0));
  const y1 = Math.max(0, Math.min(height - 1, box.y1));
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
    const base = y * width;
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) mask[base + x] = 1;
  }
  return mask;
}

module.exports = { box2dToPixels, polygonToPixels, rasterizePolygon, rasterizeBox };
