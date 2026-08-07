/**
 * Catalog paint-recommendation provider.
 *
 * The "AI" here is rule-based color theory applied to the structured house
 * understanding (see mockProvider / httpVisionProvider) and scored ONLY
 * against colors that already exist in the paint catalog table. The engine
 * never invents a color and never fabricates a swatch — every scheme is a
 * set of paint ids that resolve to real catalog rows.
 *
 * Each scheme maps roles (primary wall, accent wall, trim, doors, roof, ...)
 * to the surfaces actually detected in the analysis, and each role picks the
 * catalog paint nearest its color-theory target. Replacing this provider with
 * a learned recommender later changes no other code (registry contract).
 */
const { rgbToLab, labDistance, rgbToHsl, hslToRgb, clamp } = require('../color');

const ID = 'catalog';
const VERSION = 'catalog-rules-v1';

const ROLE_BY_CLASS = {
  'front-wall': 'primary-wall',
  'left-wall': 'accent-wall',
  'right-wall': 'accent-wall',
  roof: 'roof',
  trim: 'trim',
  door: 'doors',
  gutter: 'gutter',
  'boundary-wall': 'boundary-wall',
  columns: 'columns',
  railings: 'railings',
  balcony: 'balconies',
};

const ROLE_ORDER = ['primary-wall', 'accent-wall', 'trim', 'doors', 'roof', 'gutter', 'columns', 'railings', 'balconies', 'boundary-wall'];

// Each template is a complete, deterministic color scheme. `keep: true` on
// roof means "match the roof color already in the photo" — some schemes keep
// the roof, others are left to the fixed-hue templates' own roof handling.
const TEMPLATES = [
  {
    id: 'classic-neutral', name: 'Classic Neutrals', tagline: 'Timeless greiges with crisp white trim',
    roles: {
      'primary-wall': { hue: 'context', sMin: 0.04, sMax: 0.12, lMin: 0.5, lMax: 0.62 },
      'accent-wall': { hue: 'context', sMin: 0.12, sMax: 0.2, lMin: 0.4, lMax: 0.48 },
      trim: { hue: 'context', sMin: 0, sMax: 0.05, lMin: 0.82, lMax: 0.9, protectLight: true },
      doors: { hue: 'complement', sMin: 0.16, sMax: 0.3, lMin: 0.2, lMax: 0.3 },
      roof: { keep: true },
      gutter: { hue: 'context', sMin: 0, sMax: 0.05, lMin: 0.35, lMax: 0.45 },
    },
  },
  {
    id: 'coastal', name: 'Coastal Breeze', tagline: 'Cool blues and soft whites for a seaside feel',
    roles: {
      'primary-wall': { hue: 'fixed', hueValue: 205, sMin: 0.1, sMax: 0.2, lMin: 0.6, lMax: 0.72 },
      'accent-wall': { hue: 'fixed', hueValue: 210, sMin: 0.25, sMax: 0.4, lMin: 0.45, lMax: 0.55 },
      trim: { hue: 'context', sMin: 0, sMax: 0.04, lMin: 0.86, lMax: 0.93, protectLight: true },
      doors: { hue: 'fixed', hueValue: 215, sMin: 0.45, sMax: 0.65, lMin: 0.15, lMax: 0.25 },
      roof: { keep: true },
      gutter: { hue: 'fixed', hueValue: 210, sMin: 0, sMax: 0.06, lMin: 0.4, lMax: 0.5 },
    },
  },
  {
    id: 'modern-monochrome', name: 'Modern Monochrome', tagline: 'One hue, many depths for a sharp look',
    roles: {
      'primary-wall': { hue: 'context', sMin: 0.05, sMax: 0.12, lMin: 0.55, lMax: 0.65 },
      'accent-wall': { hue: 'context', sMin: 0.08, sMax: 0.16, lMin: 0.28, lMax: 0.36 },
      trim: { hue: 'context', sMin: 0, sMax: 0.04, lMin: 0.85, lMax: 0.92, protectLight: true },
      doors: { hue: 'context', sMin: 0.12, sMax: 0.2, lMin: 0.18, lMax: 0.24 },
      roof: { keep: true },
      gutter: { hue: 'context', sMin: 0, sMax: 0.06, lMin: 0.4, lMax: 0.5 },
    },
  },
  {
    id: 'earthy-warm', name: 'Earthy Warmth', tagline: 'Terracotta walls and cream trim',
    roles: {
      'primary-wall': { hue: 'context', sMin: 0.16, sMax: 0.26, lMin: 0.52, lMax: 0.6 },
      'accent-wall': { hue: 'context', sMin: 0.2, sMax: 0.3, lMin: 0.4, lMax: 0.46 },
      trim: { hue: 'context', sMin: 0.05, sMax: 0.1, lMin: 0.82, lMax: 0.88, protectLight: true },
      doors: { hue: 'complement', sMin: 0.2, sMax: 0.35, lMin: 0.22, lMax: 0.3 },
      roof: { keep: true },
      gutter: { hue: 'context', sMin: 0.1, sMax: 0.18, lMin: 0.34, lMax: 0.42 },
    },
  },
  {
    id: 'bold-accent', name: 'Bold Accent', tagline: 'Calm walls with a confident accent',
    roles: {
      'primary-wall': { hue: 'context', sMin: 0.03, sMax: 0.08, lMin: 0.6, lMax: 0.68 },
      'accent-wall': { hue: 'complement', sMin: 0.4, sMax: 0.55, lMin: 0.4, lMax: 0.5 },
      trim: { hue: 'context', sMin: 0, sMax: 0.03, lMin: 0.87, lMax: 0.94, protectLight: true },
      doors: { hue: 'complement', sMin: 0.3, sMax: 0.45, lMin: 0.2, lMax: 0.28 },
      roof: { keep: true },
      gutter: { hue: 'context', sMin: 0, sMax: 0.05, lMin: 0.42, lMax: 0.5 },
    },
  },
  {
    id: 'soft-pastel', name: 'Soft Pastels', tagline: 'Gentle, light-hearted tones',
    roles: {
      'primary-wall': { hue: 'analogous', delta: -12, sMin: 0.08, sMax: 0.16, lMin: 0.68, lMax: 0.78 },
      'accent-wall': { hue: 'analogous', delta: 10, sMin: 0.14, sMax: 0.24, lMin: 0.5, lMax: 0.6 },
      trim: { hue: 'context', sMin: 0, sMax: 0.04, lMin: 0.9, lMax: 0.95, protectLight: true },
      doors: { hue: 'analogous', delta: -20, sMin: 0.2, sMax: 0.35, lMin: 0.3, lMax: 0.4 },
      roof: { keep: true },
      gutter: { hue: 'context', sMin: 0, sMax: 0.06, lMin: 0.48, lMax: 0.56 },
    },
  },
  {
    id: 'heritage', name: 'Heritage Elegance', tagline: 'Deep, muted tones with a classic air',
    roles: {
      'primary-wall': { hue: 'context', sMin: 0.1, sMax: 0.18, lMin: 0.4, lMax: 0.48 },
      'accent-wall': { hue: 'context', sMin: 0.14, sMax: 0.24, lMin: 0.3, lMax: 0.38 },
      trim: { hue: 'context', sMin: 0, sMax: 0.05, lMin: 0.8, lMax: 0.86, protectLight: true },
      doors: { hue: 'complement', sMin: 0.24, sMax: 0.38, lMin: 0.16, lMax: 0.24 },
      roof: { keep: true },
      gutter: { hue: 'context', sMin: 0, sMax: 0.05, lMin: 0.32, lMax: 0.4 },
    },
  },
  {
    id: 'fresh-garden', name: 'Fresh Garden', tagline: 'Sage and leaf greens for a calm facade',
    roles: {
      'primary-wall': { hue: 'fixed', hueValue: 120, sMin: 0.08, sMax: 0.16, lMin: 0.56, lMax: 0.66 },
      'accent-wall': { hue: 'fixed', hueValue: 140, sMin: 0.16, sMax: 0.26, lMin: 0.4, lMax: 0.5 },
      trim: { hue: 'context', sMin: 0, sMax: 0.04, lMin: 0.86, lMax: 0.92, protectLight: true },
      doors: { hue: 'fixed', hueValue: 150, sMin: 0.25, sMax: 0.4, lMin: 0.2, lMax: 0.3 },
      roof: { keep: true },
      gutter: { hue: 'context', sMin: 0, sMax: 0.06, lMin: 0.4, lMax: 0.5 },
    },
  },
];

function supports(capability) {
  return capability === 'paint-recommendation';
}

async function run(capability, input) {
  if (!supports(capability)) {
    throw new Error(`catalog provider does not support capability "${capability}"`);
  }
  const { analysis, paints, count } = input;
  if (!paints || !paints.length) throw new Error('The paint catalog is empty — cannot generate recommendations.');
  const pool = filterPool(paints, input.productLines);
  const schemeCount = Math.max(1, Math.min(10, Number(count) || 6));

  // Candidate generation -> ranking -> top N (Phase 8): every template is
  // built and scored, not just the first `schemeCount` in template-definition
  // order. A house's actual context (wall hue, roof color, and — above all —
  // what's actually in *this* catalog) can make a template a poor fit even
  // though the template itself is coherent; scoring instead of truncating
  // means "this house suits neutrals better than coastal blues" is something
  // the ranking can express instead of every house getting an identical menu.
  const candidates = TEMPLATES.map((t) => buildScheme(t, analysis, pool));
  candidates.sort((a, b) => b.score - a.score);
  const schemes = candidates.slice(0, schemeCount);

  return { output: { schemes }, confidence: 1, modelVersion: VERSION };
}

function buildScheme(template, analysis, pool) {
  const ctx = analysis.context || {};
  const house = analysis.house || {};
  const wallColor = ctx.wallColor || house.color || null;
  const wallHue = wallColor ? rgbToHsl(wallColor.r, wallColor.g, wallColor.b).h : 30;
  const lighting = clamp(ctx.lighting || 1, 0.7, 1.3);

  const presentRoles = new Set();
  const classForRole = {};
  for (const s of analysis.surfaces || []) {
    if (!s.paintable) continue;
    const role = ROLE_BY_CLASS[s.className] || s.role || null;
    if (role && !presentRoles.has(role)) {
      presentRoles.add(role);
      classForRole[role] = s.className;
    }
  }

  const used = new Set();
  const surfaces = [];
  const resolvedPaints = {}; // role -> paint row, kept alongside surfaces for scoreScheme below
  let catalogFitLoss = 0; // sum of LAB distance between each role's ideal target and the nearest real paint
  let scoredRoles = 0;

  for (const role of ROLE_ORDER) {
    if (!presentRoles.has(role)) continue;
    const spec = template.roles[role];
    if (!spec) continue;

    let paint;
    let targetLab;
    if (spec.keep) {
      if (!ctx.roofColor) continue; // no roof in the analysis -> skip the role
      targetLab = rgbToLab(ctx.roofColor.r, ctx.roofColor.g, ctx.roofColor.b);
      paint = pick(pool, targetLab, used, true);
    } else {
      const target = targetFor(spec, wallHue, lighting);
      targetLab = rgbToLab(target.r, target.g, target.b);
      paint = pick(pool, targetLab, used, false);
    }
    used.add(paint.id);
    surfaces.push({ role, surfaceClass: classForRole[role], paintId: paint.id });
    resolvedPaints[role] = paint;

    // Roof (`keep`) intentionally excluded from fit scoring — it's not a
    // color-theory target, it's "match reality," so a distant catalog roof
    // color isn't the template's fault.
    if (!spec.keep) {
      catalogFitLoss += labDistance(targetLab, rgbToLab(paint.r_value, paint.g_value, paint.b_value));
      scoredRoles += 1;
    }
  }

  return {
    id: template.id,
    name: template.name,
    tagline: template.tagline,
    surfaces,
    score: scoreScheme({ catalogFitLoss, scoredRoles, resolvedPaints }),
  };
}

// Ranking (Phase 8): rewards templates the *actual* catalog can realize well
// (small average LAB distance between each role's color-theory target and
// the nearest real paint — a template whose ideal blues simply aren't
// stocked shouldn't outrank one the catalog nails) and templates that
// deliver real contrast between the primary wall and trim/doors (a scheme
// where the "trim" is barely distinguishable from the wall reads as one flat
// color, not a scheme — this is the brief's "contrast validation" step).
function scoreScheme({ catalogFitLoss, scoredRoles, resolvedPaints }) {
  // LAB distance of ~0 is a perfect catalog match; ~40+ is a poor one.
  // Normalize to 0..1 (higher is better) and average across scored roles.
  const avgLoss = scoredRoles > 0 ? catalogFitLoss / scoredRoles : 40;
  const catalogFitScore = clamp(1 - avgLoss / 40, 0, 1);

  const wall = resolvedPaints['primary-wall'];
  let contrastScore = 0.5; // neutral when there's nothing to compare (e.g. no wall role present)
  if (wall) {
    const wallL = rgbToHsl(wall.r_value, wall.g_value, wall.b_value).l;
    const deltas = ['trim', 'doors']
      .map((role) => resolvedPaints[role])
      .filter(Boolean)
      .map((paint) => Math.abs(rgbToHsl(paint.r_value, paint.g_value, paint.b_value).l - wallL));
    if (deltas.length) {
      const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      // A real coat of contrasting trim/door paint reads as >=0.15 lightness
      // delta from the wall; less than that starts to look like one flat color.
      contrastScore = clamp(avgDelta / 0.35, 0, 1);
    }
  }

  return round3(0.65 * catalogFitScore + 0.35 * contrastScore);
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

function targetFor(spec, wallHue, lighting) {
  let h;
  switch (spec.hue) {
    case 'context': h = wallHue; break;
    case 'complement': h = wallHue + 180; break;
    case 'analogous': h = wallHue + (spec.delta || 0); break;
    case 'fixed': h = spec.hueValue; break;
    default: h = wallHue;
  }
  const s = clamp((spec.sMin + spec.sMax) / 2, 0, 1);
  // Near-white/neutral roles (trim) don't shift with ambient lighting — a
  // white trim is white on a bright day and a dark one.
  const l = spec.protectLight
    ? clamp((spec.lMin + spec.lMax) / 2, 0, 1)
    : clamp((spec.lMin + spec.lMax) / 2 * lighting, 0.05, 0.95);
  return hslToRgb(h, s, l);
}

// Nearest catalog paint to a LAB target, preferring one not already used by
// this scheme so a scheme reads as a palette rather than one repeated color.
function pick(pool, targetLab, used, allowReuse) {
  let best = null, bestDist = Infinity;
  let alt = null, altDist = Infinity;
  for (const p of pool) {
    const d = labDistance(targetLab, rgbToLab(p.r_value, p.g_value, p.b_value));
    if (d < bestDist) { bestDist = d; best = p; }
    if (!used.has(p.id) && d < altDist) { altDist = d; alt = p; }
  }
  if (allowReuse) return best;
  return alt || best;
}

function filterPool(paints, productLines) {
  if (!productLines || !productLines.length) return paints;
  const filtered = paints.filter((p) => productLines.some((line) => p[line] === 1));
  return filtered.length ? filtered : paints;
}

module.exports = { id: ID, version: VERSION, supports, run };
