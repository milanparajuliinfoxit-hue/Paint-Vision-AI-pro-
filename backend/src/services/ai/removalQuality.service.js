/**
 * Post-removal damage check (Phase 4 completion).
 *
 * Compares the cleaned image against the original within the paintable
 * surface region only. If the house itself changed too much, the cleanup
 * is unsafe and gets rejected — the original is what the caller should keep
 * using. This is the "reject output, retain original" half of house-aware
 * removal; objectRemovalMask.service.js is the "don't target house pixels
 * in the first place" half — both exist because a mask being correct
 * doesn't guarantee the inpainting model actually respected it.
 */
const Jimp = require('jimp');
const aiJobsModel = require('../aiJobs.model');
const storage = require('../storage.service');

// Per-pixel Euclidean RGB distance considered "changed" (0-441 max range).
const CHANGE_DISTANCE_THRESHOLD = 40;
// Fraction of protected pixels that changed before the whole cleanup is rejected.
const DAMAGE_FRACTION_THRESHOLD = 0.08;

// Returns { damaged, changedFraction } — or { damaged: false, unverifiable: true }
// when there's no analysis to protect against, or the provider returned a
// different-sized image (can't compare pixel-for-pixel; conservatively let
// it through rather than block cleanup outright on an unrelated failure mode).
async function checkHouseDamage(assetId, originalBuffer, cleanedBuffer) {
  const analysis = await aiJobsModel.getLatestAnalysis(assetId);
  const protectedSurfaces = (analysis?.surfaces || []).filter((s) => s.paintable && s.mask_path);
  if (protectedSurfaces.length === 0) return { damaged: false, unverifiable: true };

  const [origImg, cleanImg] = await Promise.all([Jimp.read(originalBuffer), Jimp.read(cleanedBuffer)]);
  const w = origImg.bitmap.width;
  const h = origImg.bitmap.height;
  if (cleanImg.bitmap.width !== w || cleanImg.bitmap.height !== h) {
    return { damaged: false, unverifiable: true };
  }

  const protectedMask = await buildProtectedMask(protectedSurfaces, w, h);

  let protectedCount = 0;
  let changedCount = 0;
  for (let i = 0; i < protectedMask.length; i++) {
    if (!protectedMask[i]) continue;
    protectedCount++;
    const o = i * 4;
    const dr = origImg.bitmap.data[o] - cleanImg.bitmap.data[o];
    const dg = origImg.bitmap.data[o + 1] - cleanImg.bitmap.data[o + 1];
    const db = origImg.bitmap.data[o + 2] - cleanImg.bitmap.data[o + 2];
    if (Math.sqrt(dr * dr + dg * dg + db * db) > CHANGE_DISTANCE_THRESHOLD) changedCount++;
  }
  if (protectedCount === 0) return { damaged: false, unverifiable: true };

  const changedFraction = Math.round((changedCount / protectedCount) * 1000) / 1000;
  return { damaged: changedFraction > DAMAGE_FRACTION_THRESHOLD, changedFraction };
}

async function buildProtectedMask(surfaces, w, h) {
  const mask = new Uint8Array(w * h);
  for (const surface of surfaces) {
    const buf = await storage.readFile(surface.mask_path);
    const maskImg = await Jimp.read(buf);
    const sw = maskImg.bitmap.width;
    const sh = maskImg.bitmap.height;
    for (let y = 0; y < h; y++) {
      const sy = Math.min(sh - 1, Math.floor((y / h) * sh));
      for (let x = 0; x < w; x++) {
        const sx = Math.min(sw - 1, Math.floor((x / w) * sw));
        const alpha = maskImg.bitmap.data[maskImg.getPixelIndex(sx, sy) + 3];
        if (alpha > 32) mask[y * w + x] = 1;
      }
    }
  }
  return mask;
}

module.exports = { checkHouseDamage, DAMAGE_FRACTION_THRESHOLD };
