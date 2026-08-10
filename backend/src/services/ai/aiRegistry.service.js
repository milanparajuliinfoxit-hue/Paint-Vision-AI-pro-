/**
 * AI provider registry / dispatcher.
 *
 * Only responsible for selecting a provider for a capability and wrapping its
 * result in the standardized envelope (see ./aiResult.js). Provider-specific
 * behavior lives in ./providers/<id>.js; adding a provider requires only a new
 * file there (plus a registration below) — routes, controllers and the
 * frontend are untouched.
 *
 * Capabilities:
 *   'house-understanding'  -> structured house/surface/object understanding.
 *                             No production provider is registered right now
 *                             — the local Grounding DINO + SAM2 service was
 *                             removed (no remote replacement has been
 *                             verified to work yet; see .env's comment on
 *                             AI_ANALYSIS_ENABLED). houseUnderstanding
 *                             .service.js's disabled-capability check stops
 *                             requests before they'd ever reach here.
 *   'paint-recommendation' -> catalog-only paint scheme generation, or a
 *                             real hosted-LLM scheme generator (hf-scheme).
 *
 * mockProvider.js deliberately is NOT registered here — it's retained only
 * as an unreachable-from-production fixture (see its own file header). A
 * capability with no registered provider fails loudly via getProviderFor
 * below, not by silently picking a heuristic.
 */
const aiConfig = require('../../config/aiConfig');
const aiResult = require('./aiResult');
const catalogRecommendationProvider = require('./providers/catalogRecommendationProvider');
const hfSchemeProvider = require('./providers/hfSchemeProvider');

const PROVIDERS = [catalogRecommendationProvider, hfSchemeProvider];

function getProviderFor(capability) {
  const configured = aiConfig.getProviderFor(capability);
  const provider = PROVIDERS.find((p) => p.id === configured);
  if (!provider) {
    const err = new Error(`Unsupported provider "${configured}" for capability "${capability}". Registered: ${PROVIDERS.map((p) => p.id).join(', ')}`);
    err.status = 500;
    throw err;
  }
  if (!provider.supports(capability)) {
    const err = new Error(`Provider "${provider.id}" does not support capability "${capability}"`);
    err.status = 500;
    throw err;
  }
  return provider;
}

function getProviderVersion(capability) {
  try {
    return getProviderFor(capability).version;
  } catch (err) {
    return null;
  }
}

/**
 * Runs a capability through its configured provider and normalizes the result.
 * Always resolves to an aiResult envelope — never throws for provider failures.
 */
async function run(capability, input) {
  const started = Date.now();
  let provider;
  try {
    // Moved inside the try: getProviderFor throws for an unregistered/
    // unsupported provider id, and with local AI removed that's now a real
    // misconfiguration to guard (e.g. AI_ANALYSIS_PROVIDER still set to a
    // deleted provider) — previously that throw escaped run() entirely,
    // contradicting this function's own "never throws" contract below.
    provider = getProviderFor(capability);
    const result = await provider.run(capability, input);
    return aiResult.ok(result.output, {
      provider: provider.id,
      modelVersion: result.modelVersion || provider.version,
      confidence: result.confidence ?? 1,
      processingTimeMs: Date.now() - started,
    });
  } catch (err) {
    return aiResult.fail(err, {
      provider: provider?.id ?? aiConfig.getProviderFor(capability),
      modelVersion: provider?.version ?? null,
      processingTimeMs: Date.now() - started,
    });
  }
}

module.exports = { run, getProviderFor, getProviderVersion };
