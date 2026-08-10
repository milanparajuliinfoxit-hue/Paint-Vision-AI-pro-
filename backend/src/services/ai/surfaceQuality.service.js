/**
 * Surface quality validation (Phase 5).
 *
 * A provider returning a mask is not the same as that mask being usable —
 * this module scores every detected surface on more than the provider's own
 * confidence number, which for the `mock` provider is a fixed constant, not
 * a real model output (see docs/AI_VISUALIZER_ARCHITECTURE_AUDIT.md §12).
 * Pure functions, no DB/IO, operating on the provider's raw output shape
 * (`{width,height,alpha}` masks, `{x,y,w,h}` bboxes) so it can run before
 * persistence and is unit-testable without a database.
 *
 * Score = weighted average of:
 *   - model confidence            (what the provider itself reported)
 *   - area plausibility           (per-class expected size range, so a
 *                                   "trim" that becomes a giant rectangle or
 *                                   a "door" that's really the whole wall
 *                                   score low even at high confidence)
 *   - house containment           (the surface's bbox should sit inside the
 *                                   detected house bbox — a wall mask that
 *                                   bleeds into sky/road is a bad mask)
 *   - non-paintable-object overlap (a surface heavily overlapping a
 *                                   window/tree/person mask is suspect)
 *   - aspect-ratio sanity          (extreme slivers are usually noise)
 *
 * Surfaces scoring below QUALITY_THRESHOLD are still shown to the user (the
 * dealer can still see/use them) but are excluded from automatic scheme
 * generation — see paintRecommendation.service.js.
 */

const QUALITY_THRESHOLD = 0.5;

// [min, max] plausible area-of-house-bbox ratio per surface class. Anything
// outside is penalized, decaying to 0 at 3x the bound (generous — this is a
// sanity filter, not a strict classifier).
const AREA_BOUNDS = {
  roof: [0.03, 0.6],
  'front-wall': [0.02, 0.75],
  'left-wall': [0.01, 0.4],
  'right-wall': [0.01, 0.4],
  trim: [0.002, 0.2],
  gutter: [0.0005, 0.08],
  door: [0.002, 0.15],
};
const DEFAULT_AREA_BOUNDS = [0.005, 0.8];

function scoreSurface(surface, { houseBbox, width, height, objectMasks }) {
  const geometry = surface.geometry || {};
  const bbox = geometry.bbox;
  const houseArea = houseBbox ? Math.max(1, houseBbox.w * houseBbox.h) : Math.max(1, width * height);

  const confidenceScore = clamp01(surface.confidence ?? 0.5);
  const areaScore = scoreArea(geometry.areaRatio, houseArea / Math.max(1, width * height), surface.key);
  const containmentScore = scoreContainment(bbox, houseBbox);
  const objectOverlapScore = scoreObjectOverlap(surface.mask, objectMasks);
  const aspectScore = scoreAspect(bbox);

  const score = round3(
    0.3 * confidenceScore +
    0.25 * areaScore +
    0.2 * containmentScore +
    0.15 * objectOverlapScore +
    0.1 * aspectScore
  );

  return {
    score,
    tier: score >= QUALITY_THRESHOLD ? 'good' : 'low',
    breakdown: {
      confidence: round3(confidenceScore),
      area: round3(areaScore),
      houseContainment: round3(containmentScore),
      objectExclusion: round3(objectOverlapScore),
      aspectRatio: round3(aspectScore),
    },
  };
}

// Area ratio here is relative to the *whole image*, same as geometry.areaRatio
// already stored by providers — bounds are expressed the same way for a
// direct comparison (imageAreaFraction param intentionally unused beyond
// documenting the relationship; kept simple rather than re-deriving
// house-relative ratios that would require re-walking every mask).
function scoreArea(areaRatio, _houseAreaFraction, surfaceKey) {
  if (typeof areaRatio !== 'number' || !Number.isFinite(areaRatio)) return 0.5;
  const [min, max] = AREA_BOUNDS[surfaceKey] || DEFAULT_AREA_BOUNDS;
  if (areaRatio >= min && areaRatio <= max) return 1;
  if (areaRatio < min) return clamp01(areaRatio / min);
  // Above max: decay to 0 by 3x the upper bound.
  const over = (areaRatio - max) / (max * 2);
  return clamp01(1 - over);
}

function scoreContainment(bbox, houseBbox) {
  if (!bbox || !houseBbox) return 0.5;
  const ix0 = Math.max(bbox.x, houseBbox.x);
  const iy0 = Math.max(bbox.y, houseBbox.y);
  const ix1 = Math.min(bbox.x + bbox.w, houseBbox.x + houseBbox.w);
  const iy1 = Math.min(bbox.y + bbox.h, houseBbox.y + houseBbox.h);
  const interArea = Math.max(0, ix1 - ix0) * Math.max(0, iy1 - iy0);
  const bboxArea = Math.max(1, bbox.w * bbox.h);
  return clamp01(interArea / bboxArea);
}

// Fraction of this surface's "on" pixels that coincide with any non-paintable
// object's mask — capped comparison over a stride so a full per-pixel pass
// over several object masks stays cheap even at analysis resolution.
function scoreObjectOverlap(mask, objectMasks) {
  if (!mask?.alpha?.length || !objectMasks?.length) return 1;
  const stride = 3;
  let surfaceOn = 0;
  let overlapOn = 0;
  for (let i = 0; i < mask.alpha.length; i += stride) {
    if (mask.alpha[i] <= 32) continue;
    surfaceOn++;
    for (const obj of objectMasks) {
      const a = obj.alpha?.[i];
      if (a && a > 32) { overlapOn++; break; }
    }
  }
  if (surfaceOn === 0) return 1;
  const overlapFraction = overlapOn / surfaceOn;
  // Some overlap near edges (e.g. trim hugging a window frame) is normal;
  // only meaningfully penalize once a surface is substantially made of
  // pixels that belong to a detected object.
  if (overlapFraction <= 0.15) return 1;
  return clamp01(1 - (overlapFraction - 0.15) / 0.5);
}

function scoreAspect(bbox) {
  if (!bbox || bbox.w <= 0 || bbox.h <= 0) return 0.5;
  const aspect = Math.max(bbox.w, bbox.h) / Math.max(1, Math.min(bbox.w, bbox.h));
  if (aspect <= 8) return 1;
  if (aspect >= 40) return 0;
  return clamp01(1 - (aspect - 8) / 32);
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

module.exports = { scoreSurface, QUALITY_THRESHOLD };
