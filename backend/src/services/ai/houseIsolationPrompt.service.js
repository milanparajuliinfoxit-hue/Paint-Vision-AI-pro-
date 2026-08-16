/**
 * Backend-controlled Gemini house-isolation prompt builder.
 *
 * Governing brief Section 7: "extract and isolate the primary residential
 * building" — preserve all architecture, remove environmental clutter. This
 * is a FIXED system prompt, not user-configurable — no dealer text ever
 * reaches this capability (unlike visualizationPrompt.service.js, which at
 * least accepts a bounded, non-overriding stylistic-intent string).
 * Isolation is a structural/safety-sensitive edit (Section 8: "do not
 * over-promise perfect removal," "architecture preservation is more
 * important than aggressive cleanup"), so nothing here is left to per-call
 * variation.
 *
 * Pure function — no I/O, no network, trivially unit-testable.
 */

const PRESERVE_LIST = [
  'architecture', 'dimensions', 'perspective', 'roof', 'walls', 'windows',
  'doors', 'balconies', 'columns', 'pillars', 'trims', 'railings',
  'architectural details', 'textures', 'materials', 'lighting',
  'shadows belonging to the building', 'surface details',
  'the compound wall belonging to the house', 'the gate belonging to the house',
];

const REMOVE_LIST = [
  'neighboring buildings', 'trees', 'shrubs', 'plants', 'grass', 'flowers',
  'vines', 'utility poles', 'electrical wires', 'cables',
  'antennas not belonging to the building', 'scaffolding', 'ladders',
  'construction equipment', 'construction materials', 'sand', 'gravel',
  'bricks', 'debris', 'garbage', 'vehicles', 'motorcycles', 'bicycles',
  'people', 'workers', 'pedestrians', 'animals', 'birds', 'temporary objects',
  'unrelated fences', 'environmental clutter', 'watermarks', 'timestamps',
  'logos', 'unrelated text',
];

function buildIsolationPrompt() {
  return [
    'You are editing a real photograph of a house for a paint-dealer visualization tool.',
    'TASK: Extract and isolate the primary residential building in this photo.',
    `PRESERVE, unchanged, everything belonging to the house itself: ${PRESERVE_LIST.join(', ')}.`,
    'Permanent architectural structures that belong to the house — including its own compound',
    'wall, gate, pillars, balconies, and railings — must never be removed or altered, even though',
    'some of those words also appear in the removal list below when they belong to something else',
    '(e.g. an unrelated fence, not the house\'s own compound wall).',
    `REMOVE OR CLEAN, only if they are not part of the house's own architecture: ${REMOVE_LIST.join(', ')}.`,
    'If you cannot remove an object without damaging or altering the house\'s own architecture,',
    'leave that object and the architecture around it unchanged rather than risk damaging the building —',
    'preserving the house correctly is more important than aggressive cleanup.',
    'Do not invent, add, resize, or move any architectural element. Do not change the camera',
    'perspective, framing, or crop. Keep the building\'s real proportions, lighting direction, and',
    'shadows exactly as photographed. This is a cleanup/isolation edit only, not a redesign.',
  ].join(' ');
}

/**
 * The `remove_objects` task (governing brief Section 18): unlike
 * `buildIsolationPrompt` above (a fixed, comprehensive "remove everything
 * that isn't the house" instruction), this is user-intent-driven — the
 * dealer names specific things to remove ("remove the people and
 * bicycles"). The architecture-preservation rules stay identical and
 * non-negotiable; only the removal target list is dealer-specified, and
 * even that is framed so it can never be read as license to touch the
 * house itself.
 *
 * @param {string} sanitizedIntent already run through
 *   textSanitize.util.js#sanitizeUserIntent by the caller — this function
 *   does not trust or re-sanitize it, only refuses to build a prompt with
 *   nothing in it.
 */
function buildObjectRemovalPrompt(sanitizedIntent) {
  if (!sanitizedIntent) {
    throw new Error('buildObjectRemovalPrompt requires a non-empty removal instruction');
  }
  return [
    'You are editing a real photograph of a house for a paint-dealer visualization tool.',
    'TASK: Remove specific unwanted objects from this photo, exactly as instructed below —',
    'do not remove anything else.',
    `PRESERVE, unchanged, everything belonging to the house itself: ${PRESERVE_LIST.join(', ')}.`,
    'Permanent architectural structures that belong to the house — including its own compound',
    'wall, gate, pillars, balconies, and railings — must never be removed or altered, even if the',
    'instruction below could be misread as referring to them.',
    `REMOVE ONLY the following, as specifically requested by the dealer: "${sanitizedIntent}".`,
    'Do not remove or alter anything else in the photo. If a requested removal would require',
    'damaging or altering the house\'s own architecture to accomplish, leave that object and the',
    'surrounding architecture unchanged instead — preserving the house correctly is more important',
    'than completing the requested removal.',
    'Fill any removed region with plausible surrounding environment, keeping realistic perspective',
    'and lighting. Do not invent, add, resize, or move any architectural element. Do not change the',
    'camera perspective, framing, or crop. This is a targeted cleanup edit only, not a redesign.',
  ].join(' ');
}

module.exports = { buildIsolationPrompt, buildObjectRemovalPrompt, PRESERVE_LIST, REMOVE_LIST };
