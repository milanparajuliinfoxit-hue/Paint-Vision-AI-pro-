/**
 * AI capability configuration.
 *
 * Single source of truth for which AI modules are enabled, which provider
 * backs each capability, and how the modules are tuned. Every AI capability
 * must be modular, replaceable, provider independent, versioned, configurable
 * and feature flagged — the knobs below are how the last three are expressed.
 *
 * Feature flags come from environment variables (see backend/.env.example).
 */

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function intEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function csvEnv(name) {
  const raw = process.env[name];
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// capability -> provider id. Registered provider ids live in
// src/services/ai/aiRegistry.service.js (providers/*.js). No fallback
// default for house-understanding on purpose — there is currently no
// registered production provider for it (local Grounding DINO + SAM2 was
// removed; see .env), and defaulting to a heuristic here would be exactly
// the silent mock-as-AI substitution this app's own rules forbid. Leave
// AI_ANALYSIS_PROVIDER unset until a real provider is registered.
// Same "no default" rule applies to house-visualization: it's a new
// capability with no prior production provider to fall back to, and it must
// not be reachable until AI_VISUALIZATION_PROVIDER is explicitly set to a
// live-validated provider (see GEMINI_RECOLORING_IMPLEMENTATION_PLAN.md
// Phase 1 — gemini-image is registered but not live-tested as of writing).
// 'house-isolation' (governing brief Priority 2 — extract/clean the target
// house before understanding/recolor) follows the identical convention:
// registered (gemini-image, hf-image both support it), no default provider
// until AI_ISOLATION_PROVIDER is explicitly set.
const CAPABILITY_PROVIDERS = {
  'house-understanding': process.env.AI_ANALYSIS_PROVIDER || null,
  'paint-recommendation': process.env.AI_RECOMMENDATION_PROVIDER || 'catalog',
  'house-visualization': process.env.AI_VISUALIZATION_PROVIDER || null,
  'house-isolation': process.env.AI_ISOLATION_PROVIDER || null,
};

const CAPABILITY_ENABLED = {
  'house-understanding': boolEnv('AI_ANALYSIS_ENABLED', true),
  'paint-recommendation': boolEnv('AI_RECOMMENDATION_ENABLED', true),
  'house-visualization': boolEnv('AI_VISUALIZATION_ENABLED', true),
  'house-isolation': boolEnv('AI_ISOLATION_ENABLED', true),
};

function isCapabilityEnabled(capability) {
  return CAPABILITY_ENABLED[capability] !== false;
}

function getProviderFor(capability) {
  return CAPABILITY_PROVIDERS[capability] || null;
}

// 5-10 complete schemes per the product spec; clamp defensively.
function getRecommendationCount() {
  return Math.min(10, Math.max(1, intEnv('AI_RECOMMENDATION_COUNT', 6)));
}

// Analysis runs on a downscaled copy of the photo; the masks it produces are
// scaled back up client-side so the renderer's resolution is never limited.
function getAnalysisMaxDim() {
  return intEnv('AI_ANALYSIS_MAX_DIM', 640);
}

// Optional dealer/brand preference: only recommend from these product lines.
// Falls back to the whole catalog when the filtered pool is empty.
function getRecommendationProductLines() {
  return csvEnv('AI_RECOMMENDATION_PRODUCT_LINES');
}

module.exports = {
  isCapabilityEnabled,
  getProviderFor,
  getRecommendationCount,
  getAnalysisMaxDim,
  getRecommendationProductLines,
  CAPABILITY_PROVIDERS,
};
