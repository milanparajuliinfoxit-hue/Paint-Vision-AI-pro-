const logger = require('../logger.service');

/**
 * Shared HTTP primitives for AI providers.
 *
 * Centralizes the things every provider needs: a 30s request timeout,
 * retry-with-backoff for transient failures (429 / 503 / 504), descriptive
 * errors that always include the provider's response body, and structured
 * logging of latency/status/request-id.
 */

const DEFAULT_TIMEOUT_MS = 30 * 1000;
const MAX_RETRIES = 2;
const RETRYABLE_STATUSES = new Set([429, 503, 504]);

class ProviderError extends Error {
  constructor(message, { status, provider, model, requestId, retriable = false, cause } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.provider = provider;
    this.model = model;
    this.requestId = requestId;
    this.retriable = retriable;
    this.cause = cause;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt) {
  return Math.min(500 * 2 ** (attempt - 1), 4000);
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeoutError = new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
      timeoutError.name = 'TimeoutError';
      throw timeoutError;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // matches the app's largest multer upload cap

// GET with timeout + a hard response-size cap, for the one place a provider
// response hands back a URL for us to fetch (huggingface.js's
// fetchRemoteImage) rather than the image bytes directly. That URL is
// attacker-influenced if a provider endpoint is ever compromised or
// misbehaves, and without a cap here the Authorization header (the HF key)
// would be sent to whatever host it names with no timeout and no bound on
// how much it could make us download.
async function getWithLimits(url, { headers, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, provider, model } = {}) {
  const response = await fetchWithTimeout(url, { method: 'GET', headers }, timeoutMs);
  if (!response.ok) {
    throw new ProviderError(`Failed to download resource from ${url} (HTTP ${response.status})`, { provider, model });
  }

  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ProviderError(`Resource at ${url} exceeds the ${maxBytes}-byte limit (declared ${declaredLength} bytes)`, { provider, model });
  }

  // Enforced during the stream, not just via Content-Length (which a server
  // can omit or lie about) — the cap actually bounds memory even against a
  // response with no declared length.
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new ProviderError(`Resource at ${url} exceeds the ${maxBytes}-byte limit`, { provider, model });
    }
    return buffer;
  }

  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ProviderError(`Resource at ${url} exceeds the ${maxBytes}-byte limit`, { provider, model });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function extractErrorDetail(response) {
  const text = await response.text().catch(() => '');
  if (!text) return '';
  try {
    const json = JSON.parse(text);
    const message = json.error || json.message || json.detail;
    return typeof message === 'string' && message.length > 0 ? message : text.slice(0, 500);
  } catch {
    return text.slice(0, 500);
  }
}

/**
 * POST with timeout + retry. Resolves with the Response on success (body is
 * left unconsumed for the caller to parse). Throws ProviderError on failure,
 * including the provider's error detail when one is available.
 */
async function post({ url, headers, body, provider, model, timeoutMs = DEFAULT_TIMEOUT_MS, maxRetries = MAX_RETRIES }) {
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    let response;
    try {
      response = await fetchWithTimeout(url, { method: 'POST', headers, body }, timeoutMs);
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      if (attempt <= maxRetries) {
        logger.warn({ provider, model, message: `attempt ${attempt} failed: ${err.message}`, errorName: err.name, latencyMs });
        await sleep(backoffMs(attempt));
        continue;
      }
      logger.error({ provider, model, message: `request failed after ${attempt} attempts: ${err.message}`, errorName: err.name, latencyMs });
      throw new ProviderError(`Network error while calling ${provider}: ${err.message}`, { provider, model, retriable: true, cause: err });
    }

    const latencyMs = Date.now() - startedAt;
    const requestId = response.headers.get('x-request-id') || undefined;

    if (response.ok) {
      logger.info({ provider, model, status: response.status, latencyMs, requestId });
      return response;
    }

    const detail = await extractErrorDetail(response);
    const retriable = RETRYABLE_STATUSES.has(response.status);

    if (retriable && attempt <= maxRetries) {
      logger.warn({ provider, model, status: response.status, latencyMs, requestId, message: `attempt ${attempt} failed (retriable)` });
      await sleep(backoffMs(attempt));
      continue;
    }

    logger.error({ provider, model, status: response.status, latencyMs, requestId, message: `provider returned ${response.status}`, detail });
    throw new ProviderError(`Provider error (${response.status}): ${detail || 'no detail in response body'}`, {
      status: response.status,
      provider,
      model,
      requestId,
      retriable,
    });
  }

  throw new ProviderError(`Exhausted retries for ${provider}`, { provider, model });
}

module.exports = {
  post,
  getWithLimits,
  ProviderError,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  MAX_RETRIES,
  RETRYABLE_STATUSES,
};
