// Maps a fixed architecturalCategories key (governing brief's Gemini-first
// migration vocabulary — see backend/src/services/ai/architecturalCategories.js)
// to the real detected_surfaces rows it plausibly corresponds to, so
// "Apply to Editable Layers" (AIWorkspaceTab.jsx) can find a real mask to
// paint even though the AI Visualization workflow itself never requires a
// prior segmentation run. When no analysis exists yet, this always returns
// an empty array — the caller then honestly reports nothing was applied
// rather than fabricating a layer with no mask.
//
// Deliberately substring/role heuristics, not an exact key match — detected
// class_keys (front-wall, window-frame-2, ...) use a different, more
// granular vocabulary than the fixed category list (primary-wall, window,
// ...) by design (Section 20 of the earlier grouping work already handles
// per-instance numbering; this layer bridges the two vocabularies).
const ALIASES = {
  'primary-wall': (s) => s.properties?.role === 'primary-wall' || /front-wall|^wall$/.test(s.class_key),
  'accent-wall': (s) => s.properties?.role === 'accent-wall' || /left-wall|right-wall|side-wall|back-wall/.test(s.class_key),
  trim: (s) => s.properties?.role === 'trim' || /trim/.test(s.class_key),
  gutter: (s) => s.properties?.role === 'gutter' || /gutter/.test(s.class_key),
  doors: (s) => (s.properties?.role === 'doors' || /door/.test(s.class_key)) && !/garage/.test(s.class_key),
  window: (s) => /window/.test(s.class_key),
  railing: (s) => /railing/.test(s.class_key),
  column: (s) => /pillar|column/.test(s.class_key),
  balcony: (s) => /balcony/.test(s.class_key),
  roof: (s) => s.properties?.role === 'roof' || /roof/.test(s.class_key),
  'compound-wall': (s) => /compound/.test(s.class_key),
  gate: (s) => /gate/.test(s.class_key) && !/garage/.test(s.class_key),
  'garage-door': (s) => /garage/.test(s.class_key),
};

export function matchSurfacesForCategory(categoryKey, surfaces) {
  const test = ALIASES[categoryKey];
  if (!test || !Array.isArray(surfaces)) return [];
  return surfaces.filter((s) => s.paintable !== false && test(s));
}

export { ALIASES };
