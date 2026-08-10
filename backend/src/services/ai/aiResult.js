/**
 * Standardized AI result envelope.
 *
 * Every AI module in the system returns this shape, no matter the provider:
 *   { ok, output, confidence, processingTimeMs, modelVersion, provider, failureReason }
 *
 * That contract is what keeps providers swappable — routes/controllers/frontend
 * only ever see the envelope, never a provider's own response format.
 */

function ok(output, meta = {}) {
  return {
    ok: true,
    output,
    confidence: meta.confidence ?? 1,
    processingTimeMs: meta.processingTimeMs ?? 0,
    modelVersion: meta.modelVersion ?? null,
    provider: meta.provider ?? 'unknown',
    failureReason: null,
  };
}

function fail(failureReason, meta = {}) {
  return {
    ok: false,
    output: null,
    confidence: 0,
    processingTimeMs: meta.processingTimeMs ?? 0,
    modelVersion: meta.modelVersion ?? null,
    provider: meta.provider ?? 'unknown',
    failureReason: failureReason instanceof Error ? failureReason.message : String(failureReason),
  };
}

module.exports = { ok, fail };
