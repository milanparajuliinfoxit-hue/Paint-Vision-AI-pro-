/**
 * Fixed semantic architectural categories — the canonical, human-meaningful
 * paint targets a dealer assigns catalog colors to.
 *
 * Governing brief (Gemini-first migration) Section 3/4/8/17: pixel
 * segmentation (detected_surfaces, one row per detected instance — "Window
 * ×7") must stop being a hard prerequisite for using AI visualization. This
 * module is the fixed, small vocabulary that replaces "validate against
 * whatever the last analysis happened to detect" as the source of truth for
 * which surfaceKeys a color plan may reference. It exists independent of
 * any AI call — a dealer can assign "Primary wall -> Ocean Mist" the moment
 * a photo is uploaded, with zero segmentation having ever run.
 *
 * When a real house-understanding analysis IS available, the frontend may
 * still use it to enrich/autofill this list (e.g. hide "Compound wall" if
 * none was detected) — that's a UX nicety, never a requirement. The backend
 * validation in visualization.service.js only ever checks against this
 * fixed list, never against detected_surfaces.
 *
 * Keys `primary-wall`/`accent-wall`/`trim`/`roof`/`gutter`/`doors`
 * deliberately match the pre-existing `properties.role` vocabulary already
 * used by scheme generation (houseSceneNormalizer.js, RecommendationsTab.jsx
 * ROLE_LABELS) rather than inventing a second, slightly different naming —
 * that's what lets a scheme's "Generate photorealistic" action (brief §29,
 * optional/secondary but still real) submit the exact same surfaceKey
 * vocabulary as the new primary AI Workspace, with no translation layer.
 */

const CATEGORIES = [
  { key: 'primary-wall', label: 'Primary Wall' },
  { key: 'accent-wall', label: 'Accent Wall' },
  { key: 'trim', label: 'Trim' },
  { key: 'doors', label: 'Doors' },
  { key: 'window', label: 'Window / Grille' },
  { key: 'railing', label: 'Railing' },
  { key: 'column', label: 'Column / Pillar' },
  { key: 'balcony', label: 'Balcony' },
  { key: 'roof', label: 'Roof' },
  { key: 'gutter', label: 'Gutter' },
  { key: 'compound-wall', label: 'Compound Wall' },
  { key: 'gate', label: 'Gate' },
  { key: 'garage-door', label: 'Garage Door' },
];

const CATEGORY_KEYS = new Set(CATEGORIES.map((c) => c.key));
const LABEL_BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c.label]));

function isValidCategory(key) {
  return CATEGORY_KEYS.has(key);
}

function labelFor(key) {
  return LABEL_BY_KEY.get(key) || key;
}

module.exports = { CATEGORIES, isValidCategory, labelFor };
