/**
 * Bounds and cleans dealer-supplied free text before it goes anywhere near a
 * Gemini prompt (governing brief Section 4/10/34): strip control
 * characters, collapse whitespace, hard-cap length. This is advisory
 * tone/style/target text only — callers (visualizationPrompt.service.js,
 * houseIsolationPrompt.service.js) are responsible for framing it as
 * strictly non-overriding relative to catalog colors / preservation rules;
 * this function only handles the text-safety half.
 *
 * Extracted from visualization.service.js so the same sanitizer backs both
 * the recolor "user intent" field and the new remove-objects "what to
 * remove" field, rather than two divergent copies.
 */

const MAX_INTENT_LENGTH = 500;

function sanitizeUserIntent(raw, maxLength = MAX_INTENT_LENGTH) {
  if (typeof raw !== 'string') return '';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const isControl = code <= 0x1f || code === 0x7f;
    out += isControl ? ' ' : raw[i];
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

module.exports = { sanitizeUserIntent, MAX_INTENT_LENGTH };
