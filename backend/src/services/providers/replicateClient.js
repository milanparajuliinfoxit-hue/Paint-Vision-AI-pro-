/**
 * Thin Replicate prediction-lifecycle client.
 *
 * Replicate's REST contract (POST /v1/predictions -> {id,status,...}, then
 * poll GET until status is terminal) is generic across every model on the
 * platform — this file has zero knowledge of grounding-dino/sam-2
 * specifically, that lives in providers/replicateVisionProvider.js. Kept
 * separate from httpClient.js because httpClient.js is transport-generic
 * (any provider's HTTP calls); this is Replicate's own prediction state
 * machine built on top of it.
 *
 * Confirmed from Replicate's own HTTP API reference (see
 * AI_HOSTED_ARCHITECTURE.md §4) — not guessed.
 */
const { post, getWithLimits, ProviderError } = require('./httpClient');

const API_BASE = 'https://api.replicate.com/v1';
const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);

// Resolved "owner/name" -> 64-char version id, per process. Live-tested
// (see AI_HOSTED_VALIDATION_REPORT.md): neither `{version:"owner/name"}` on
// the generic /v1/predictions endpoint (422 "specified version does not
// exist") nor POST /v1/models/{owner}/{name}/predictions (404) work for
// adirik/grounding-dino or meta/sam-2 — both are real, high-traffic public
// models (39.5M / 212k runs respectively) but not Replicate "official"
// (verified-org) listings, which is what those two shortcuts require. The
// generic endpoint with the model's actual `latest_version.id` (from
// GET /v1/models/{owner}/{name}) is what actually works. Resolved fresh per
// process (not hardcoded) so a model update doesn't silently pin a stale
// version forever.
const versionCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function resolveVersionId(token, model, providerName) {
  if (versionCache.has(model)) return versionCache.get(model);
  const buf = await getWithLimits(`${API_BASE}/models/${model}`, {
    headers: authHeaders(token),
    timeoutMs: 10000,
    maxBytes: 1024 * 1024,
    provider: providerName,
    model,
  });
  const data = JSON.parse(buf.toString('utf8'));
  const versionId = data.latest_version?.id;
  if (!versionId) {
    throw new ProviderError(`Replicate model ${model} has no resolvable latest_version`, { provider: providerName, model });
  }
  versionCache.set(model, versionId);
  return versionId;
}

/**
 * Starts a prediction for `model` ("owner/name", always the latest version)
 * and polls until it reaches a terminal state. Never resolves with a
 * non-succeeded result — failed/canceled/timed-out all throw ProviderError,
 * so callers never have to remember to check `.status` themselves.
 *
 * Deliberately does NOT use Replicate's `Prefer: wait` synchronous mode
 * (capped at 60s by Replicate) — a two-stage pipeline (detect, then
 * per-class segment) can plausibly exceed that on a cold start, and an
 * explicit poll loop with its own timeout is clearer than an ambiguous
 * "did it finish or just give up waiting" response.
 */
async function runPrediction({ token, model, input, providerName, createTimeoutMs = 30000, pollIntervalMs = 1500, pollTimeoutMs = 45000 }) {
  if (!token) {
    throw new ProviderError(`REPLICATE_API_TOKEN is missing — required for ${providerName}`, { provider: providerName, model });
  }

  const versionId = await resolveVersionId(token, model, providerName);
  const createResponse = await post({
    url: `${API_BASE}/predictions`,
    provider: providerName,
    model,
    timeoutMs: createTimeoutMs,
    headers: authHeaders(token),
    body: JSON.stringify({ version: versionId, input }),
  });
  let prediction = await createResponse.json();

  const deadline = Date.now() + pollTimeoutMs;
  while (!TERMINAL.has(prediction.status)) {
    if (Date.now() > deadline) {
      await cancelBestEffort(prediction, token);
      throw new ProviderError(`Replicate prediction for ${model} timed out after ${pollTimeoutMs}ms`, { provider: providerName, model });
    }
    await sleep(pollIntervalMs);
    const getUrl = prediction.urls?.get || `${API_BASE}/predictions/${prediction.id}`;
    const buf = await getWithLimits(getUrl, {
      headers: authHeaders(token),
      timeoutMs: 10000,
      maxBytes: 2 * 1024 * 1024,
      provider: providerName,
      model,
    });
    prediction = JSON.parse(buf.toString('utf8'));
  }

  if (prediction.status !== 'succeeded') {
    throw new ProviderError(`Replicate prediction for ${model} ${prediction.status}: ${prediction.error || 'no error detail'}`, { provider: providerName, model });
  }
  return prediction.output;
}

// Best-effort cancel of an abandoned prediction so a poll timeout doesn't
// keep billing in the background. A failed cancel must never mask the
// timeout error the caller is about to throw.
async function cancelBestEffort(prediction, token) {
  const cancelUrl = prediction?.urls?.cancel;
  if (!cancelUrl) return;
  try {
    await post({ url: cancelUrl, provider: 'replicate', timeoutMs: 5000, headers: authHeaders(token), body: '' });
  } catch {
    // swallowed intentionally
  }
}

// Exported so callers (replicateVisionProvider.js) can capture the real
// resolved version hash for ai_jobs.model_version traceability (governing
// brief §19: "grounding-dino"/"sam-2" alone isn't sufficient reproducibility
// metadata) without a second network call — runPrediction() already
// resolved and cached it during the actual call.
module.exports = { runPrediction, resolveVersionId };
