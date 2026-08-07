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
 *   'house-understanding'  -> structured house/surface/object understanding
 *   'paint-recommendation' -> catalog-only paint scheme generation
 */
const aiConfig = require('../../config/aiConfig');
const aiResult = require('./aiResult');
const mockProvider = require('./providers/mockProvider');
const httpVisionProvider = require('./providers/httpVisionProvider');
const hfVisionProvider = require('./providers/hfVisionProvider');
const catalogRecommendationProvider = require('./providers/catalogRecommendationProvider');

const PROVIDERS = [mockProvider, httpVisionProvider, hfVisionProvider, catalogRecommendationProvider];

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
  const provider = getProviderFor(capability);
  const started = Date.now();
  try {
    const result = await provider.run(capability, input);
    return aiResult.ok(result.output, {
      provider: provider.id,
      modelVersion: result.modelVersion || provider.version,
      confidence: result.confidence ?? 1,
      processingTimeMs: Date.now() - started,
    });
  } catch (err) {
    return aiResult.fail(err, {
      provider: provider.id,
      modelVersion: provider.version,
      processingTimeMs: Date.now() - started,
    });
  }
}

module.exports = { run, getProviderFor, getProviderVersion };
