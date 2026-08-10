/**
 * Per-key concurrency guard against duplicate expensive work (AI provider
 * calls). A second caller for the same key doesn't re-run the work — it
 * awaits and receives the *same* result as the first caller.
 *
 * This exists because the manual "Analyze"/"Generate schemes" buttons
 * (houseUnderstanding.analyzeAsset, paintRecommendation.generateRecommendations)
 * had no duplicate-request protection at all — only the autonomous pipeline
 * (aiPipeline.service.js) did, via its own bespoke in-flight Set. A
 * double-clicked button or a slow network causing a retry could fire two
 * concurrent provider calls for the same asset, double-billing external
 * providers and racing two ai_jobs writes against each other. Locking here,
 * at the service functions both entry points ultimately call, protects
 * both — aiPipeline.service.js keeps its own outer guard too (cheap, avoids
 * redundant pipeline-orchestration overhead), but the correctness guarantee
 * ("duplicate processing prevented") lives here now, not just in one caller.
 *
 * In-process only (a Map, not Redis) — single Node process, matching every
 * other in-memory guard already in this codebase (mask-write queue on the
 * frontend, preview cache).
 */
const inFlight = new Map(); // key -> Promise

function withLock(key, work) {
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = Promise.resolve()
    .then(work)
    .finally(() => {
      // Only delete if this is still the promise registered under `key` —
      // guards against deleting a newer entry if something unexpected
      // reordered (defensive; shouldn't happen given the Map is only ever
      // written here).
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });

  inFlight.set(key, promise);
  return promise;
}

module.exports = { withLock };
