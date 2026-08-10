/**
 * Object classification (Phase 3/4 shared).
 *
 * The house-understanding contract already distinguishes PAINTABLE (a
 * surface, e.g. front-wall) from everything else (an "object"). This adds
 * the brief's second axis for those objects: is it a NON-PAINTABLE HOUSE
 * COMPONENT (part of the house, never painted or removed — a window) or an
 * UNRELATED OBJECT (not part of the house at all, and safe to auto-remove —
 * a tree, car, person, or fence)?
 *
 * Single source of truth for both the analysis response (category label,
 * added in aiJobs.model.js's decodeObject) and the default removal mask
 * (objectRemovalMask.service.js) — they must never classify a class_key
 * differently from each other, so both read from here rather than keeping
 * their own copy of "which classes are removable."
 *
 * Computed on read, not persisted — category is a pure function of
 * class_key, so storing it would just be a value that could drift from this
 * table instead of one that can't.
 */
const REMOVABLE_CLASSES = new Set(['tree', 'car', 'person', 'fence']);

const NON_PAINTABLE_HOUSE_COMPONENT = 'non-paintable-house-component';
const UNRELATED_OBJECT = 'unrelated-object';

function classifyObject(classKey) {
  return REMOVABLE_CLASSES.has(classKey) ? UNRELATED_OBJECT : NON_PAINTABLE_HOUSE_COMPONENT;
}

module.exports = { REMOVABLE_CLASSES, classifyObject, NON_PAINTABLE_HOUSE_COMPONENT, UNRELATED_OBJECT };
