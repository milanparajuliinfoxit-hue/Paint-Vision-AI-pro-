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
    stage: meta.stage ?? 'completed',
  };
}

// `stage`/`retryable` (governing brief §17/§18): which pipeline stage
// actually failed and whether a caller could reasonably retry as-is (a
// timeout/429/503 vs. a missing token or invalid image never will).
// Optional, additive — a provider that never sets err.stage/err.retriable
// (mockProvider, catalogRecommendationProvider, hfSchemeProvider) just gets
// the same `stage: null, retryable: false` defaults as before this field
// existed.
function fail(failureReason, meta = {}) {
  const err = failureReason instanceof Error ? failureReason : null;
  return {
    ok: false,
    output: null,
    confidence: 0,
    processingTimeMs: meta.processingTimeMs ?? 0,
    modelVersion: meta.modelVersion ?? null,
    provider: meta.provider ?? 'unknown',
    failureReason: err ? err.message : String(failureReason),
    stage: meta.stage ?? err?.stage ?? null,
    retryable: meta.retryable ?? err?.retriable ?? false,
  };
}

module.exports = { ok, fail };
