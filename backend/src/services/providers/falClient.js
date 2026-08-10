/**
 * Thin fal.ai queue-lifecycle client (raw REST, no @fal-ai/client dependency
 * — same "no SDK, just fetch through httpClient.js" convention as
 * replicateClient.js, for one consistent HTTP/retry/timeout/logging story
 * across every hosted AI provider in this app).
 *
 * Contract confirmed from fal.ai's own JS client source
 * (github.com/fal-ai/fal-js, libs/client/src/queue.ts) and its auth docs —
 * not guessed:
 *   - POST https://queue.fal.run/{model_id}  body = the raw model input
 *     object (NOT wrapped in {input: ...}) -> {request_id, status,
 *     status_url, response_url, cancel_url, queue_position}
 *   - GET  {status_url}   -> {status: "IN_QUEUE"|"IN_PROGRESS"|"COMPLETED"|"ERROR", ...}
 *   - GET  {response_url} -> the model's own output JSON, directly
 *   - PUT  {cancel_url}   -> best-effort cancel
 *   - Auth header: `Authorization: Key <FAL_API_KEY>` (not Bearer — fal's
 *     own scheme, confirmed from docs.fal.ai/reference/platform-apis/authentication)
 *
 * See AI_HOSTED_ARCHITECTURE.md §9 for the full provider-selection writeup.
 */
const { post, getWithLimits, ProviderError } = require('./httpClient');

const QUEUE_BASE = 'https://queue.fal.run';
const TERMINAL = new Set(['COMPLETED', 'ERROR']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function authHeaders(apiKey) {
  return { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' };
}

/**
 * Submits `input` to fal's queue for `model` ("owner/name[/variant]") and
 * polls until COMPLETED/ERROR. Never resolves with a non-COMPLETED result —
 * ERROR/timeout both throw ProviderError, matching replicateClient.js's
 * runPrediction contract so both providers' callers can be written the same way.
 */
async function runModel({ apiKey, model, input, providerName, createTimeoutMs = 30000, pollIntervalMs = 1500, pollTimeoutMs = 45000 }) {
  if (!apiKey) {
    throw new ProviderError(`FAL_API_KEY is missing — required for ${providerName}`, { provider: providerName, model });
  }

  const createResponse = await post({
    url: `${QUEUE_BASE}/${model}`,
    provider: providerName,
    model,
    timeoutMs: createTimeoutMs,
    headers: authHeaders(apiKey),
    body: JSON.stringify(input),
  });
  const submission = await createResponse.json();

  const statusUrl = submission.status_url || `${QUEUE_BASE}/${model}/requests/${submission.request_id}/status`;
  const responseUrl = submission.response_url || `${QUEUE_BASE}/${model}/requests/${submission.request_id}`;
  const cancelUrl = submission.cancel_url || `${QUEUE_BASE}/${model}/requests/${submission.request_id}/cancel`;

  let status = submission.status;
  const deadline = Date.now() + pollTimeoutMs;
  while (!TERMINAL.has(status)) {
    if (Date.now() > deadline) {
      await cancelBestEffort(cancelUrl, apiKey);
      throw new ProviderError(`fal.ai request for ${model} timed out after ${pollTimeoutMs}ms`, { provider: providerName, model });
    }
    await sleep(pollIntervalMs);
    const buf = await getWithLimits(statusUrl, {
      headers: authHeaders(apiKey),
      timeoutMs: 10000,
      maxBytes: 1024 * 1024,
      provider: providerName,
      model,
    });
    status = JSON.parse(buf.toString('utf8')).status;
  }

  if (status !== 'COMPLETED') {
    throw new ProviderError(`fal.ai request for ${model} ended with status ${status}`, { provider: providerName, model });
  }

  const buf = await getWithLimits(responseUrl, {
    headers: authHeaders(apiKey),
    timeoutMs: 15000,
    maxBytes: 5 * 1024 * 1024,
    provider: providerName,
    model,
  });
  return JSON.parse(buf.toString('utf8'));
}

// Best-effort cancel of an abandoned request so a poll timeout doesn't keep
// running in the background. fal's cancel is PUT, which httpClient.js's
// post() doesn't support (POST-only) — raw fetch here rather than widening
// a shared, already-well-tested helper for one non-critical call. A failed
// cancel must never mask the timeout error the caller is about to throw.
async function cancelBestEffort(cancelUrl, apiKey) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      await fetch(cancelUrl, { method: 'PUT', headers: authHeaders(apiKey), signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // swallowed intentionally
  }
}

module.exports = { runModel };
