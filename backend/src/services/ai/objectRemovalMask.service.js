/**
 * House-aware default object-removal mask (Phase 4).
 *
 * Builds a default "remove this" mask for POST /assets/:id/clean from the
 * asset's own house-understanding analysis, so a dealer doesn't have to
 * hand-draw a mask around every tree/car/person/fence in frame before
 * running cleanup. Only used when the caller didn't upload their own mask —
 * an explicit user-drawn mask always wins outright (see assets.controller.js).
 *
 * Safety: the mask never touches pixels belonging to a detected paintable
 * surface. That's enforced twice, independently — only object classes that
 * are never part of a house are eligible at all (REMOVABLE_CLASSES;
 * `window` is deliberately excluded even though it's non-paintable, since a
 * window is part of the house structure, not an obstruction), and every
 * paintable surface mask is then stamped back to "keep" on top of whatever
 * the object masks produced, so an overlapping detection (e.g. a tree
 * branch crossing in front of a wall) can never erase house pixels.
 *
 * Mask convention matches Clipdrop's Cleanup API (the default AI_PROVIDER):
 * opaque white = remove, opaque black = keep. Hugging Face providers treat
 * the mask buffer as an opaque pass-through configured per model, so the
 * same image works there without change.
 */
const Jimp = require('jimp');
const aiJobsModel = require('../aiJobs.model');
const storage = require('../storage.service');
const { REMOVABLE_CLASSES } = require('./objectClassification');

const KEEP = 0x000000ff;
const REMOVE = 0xffffffff;

// Returns a PNG Buffer sized to (targetWidth, targetHeight) — the caller's
// original photo dimensions — or null when there's no analysis yet, or
// nothing removable was detected. A null return means "no default available,
// behave exactly as before this feature existed" (cleanup runs with no mask).
async function buildDefaultRemovalMask(assetId, targetWidth, targetHeight) {
  if (!targetWidth || !targetHeight) return null;

  const analysis = await aiJobsModel.getLatestAnalysis(assetId);
  if (!analysis) return null;

  const removable = (analysis.objects || []).filter((o) => REMOVABLE_CLASSES.has(o.class_key) && o.mask_path);
  if (removable.length === 0) return null;

  const protectedSurfaces = (analysis.surfaces || []).filter((s) => s.paintable && s.mask_path);

  const canvas = new Jimp(targetWidth, targetHeight, KEEP);
  for (const obj of removable) {
    await stampMask(canvas, obj.mask_path, targetWidth, targetHeight, REMOVE);
  }
  for (const surface of protectedSurfaces) {
    await stampMask(canvas, surface.mask_path, targetWidth, targetHeight, KEEP);
  }

  return canvas.getBufferAsync(Jimp.MIME_PNG);
}

// Loads a stored alpha-PNG mask (analysis resolution, e.g. 640px) and
// stamps `color` onto `canvas` (original photo resolution) wherever the
// source mask's alpha is "on", nearest-neighbor sampled. Pixel-perfect edge
// accuracy doesn't matter for a removal mask — class membership does, and
// inpainting naturally blends a few px of slop at a boundary.
async function stampMask(canvas, maskPath, targetWidth, targetHeight, color) {
  const buffer = await storage.readFile(maskPath);
  const maskImg = await Jimp.read(buffer);
  const sw = maskImg.bitmap.width;
  const sh = maskImg.bitmap.height;

  for (let y = 0; y < targetHeight; y++) {
    const sy = Math.min(sh - 1, Math.floor((y / targetHeight) * sh));
    for (let x = 0; x < targetWidth; x++) {
      const sx = Math.min(sw - 1, Math.floor((x / targetWidth) * sw));
      const alpha = maskImg.bitmap.data[maskImg.getPixelIndex(sx, sy) + 3];
      if (alpha > 32) canvas.setPixelColor(color, x, y);
    }
  }
}

module.exports = { buildDefaultRemovalMask, REMOVABLE_CLASSES };
