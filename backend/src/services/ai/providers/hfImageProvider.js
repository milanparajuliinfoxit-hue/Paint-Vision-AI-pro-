/**
 * Development-fallback house-visualization provider ("hf-image") — Hugging
 * Face Inference Providers, same router endpoint + FLUX.2 edit model already
 * proven working in this repo for cleanup (providers/huggingface.js,
 * HF_API_KEY/HF_MODEL/HF_API_URL — "Verified reachable config" per
 * .env.example). This is a SEPARATE house-visualization provider, not a
 * reuse of the cleanup path — cleanup always sends the fixed HF_PROMPT
 * (object removal); this sends the caller's recolor prompt instead. Never
 * touches providers/huggingface.js, so the existing cleanup feature is
 * unaffected by this file's existence.
 *
 * Exists per GEMINI_RECOLORING_IMPLEMENTATION_PLAN.md's "keep the provider
 * abstraction capable of a second provider" guidance and the explicit
 * instruction to keep development moving when Gemini's image-generation
 * quota is 0 (real, external, account-level block — see
 * GEMINI_IMPLEMENTATION_FINAL_REPORT.md §7). This uses REAL, already-
 * configured HF credentials — it is not a mock and never fabricates a
 * result — but it is explicitly NOT Gemini, and both the provider id
 * ("hf-image") and the frontend surface this distinction rather than
 * hiding it (see RecommendationsTab.jsx's dev-fallback badge).
 */
const { post, ProviderError } = require('../../providers/httpClient');
const logger = require('../../logger.service');

const ID = 'hf-image';
const VERSION = 'hf-flux2-edit-v1';

const IMAGE_MAGIC = [
  { bytes: [0x89, 0x50, 0x4e, 0x47], type: 'PNG' },
  { bytes: [0xff, 0xd8, 0xff], type: 'JPEG' },
];

function supports(capability) {
  return capability === 'house-visualization' || capability === 'house-isolation';
}

async function run(capability, input) {
  if (!supports(capability)) {
    throw new Error(`hf-image provider does not support capability "${capability}"`);
  }
  const apiKey = (process.env.HF_API_KEY || '').trim();
  const model = (process.env.HF_MODEL || '').trim();
  const url = (process.env.HF_API_URL || '').trim();
  if (!apiKey || !model || !url) {
    throw taggedError('HF_API_KEY/HF_MODEL/HF_API_URL missing — see backend/.env.example', 'config');
  }
  if (!input?.prompt) {
    throw taggedError('No prompt provided — visualizationPrompt.service.js must build one first', 'config');
  }

  const timeoutEnvVar = capability === 'house-isolation' ? 'AI_ISOLATION_TIMEOUT_MS' : 'AI_VISUALIZATION_TIMEOUT_MS';
  const timeoutMs = Number(process.env[timeoutEnvVar]) || 90000;
  const started = Date.now();

  const mimeType = input.mimeType || 'image/jpeg';
  const base64 = Buffer.isBuffer(input.buffer) ? input.buffer.toString('base64') : input.buffer;
  const imageField = process.env.HF_IMAGE_FIELD || 'image_urls';
  const payload = { prompt: input.prompt, [imageField]: [`data:${mimeType};base64,${base64}`] };

  const response = await post({
    url,
    provider: ID,
    model,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeoutMs,
  });

  const buffer = await parseImageResponse(response, model);
  const durationMs = Date.now() - started;
  logger.info({ provider: ID, stage: 'generate', durationMs, outputBytes: buffer.length });

  return { output: { buffer, mimeType: detectMimeType(buffer) }, confidence: 1, modelVersion: model };
}

function looksLikeImage(buffer) {
  return IMAGE_MAGIC.some(({ bytes }) => bytes.every((b, i) => buffer[i] === b));
}

function detectMimeType(buffer) {
  const match = IMAGE_MAGIC.find(({ bytes }) => bytes.every((b, i) => buffer[i] === b));
  return match?.type === 'PNG' ? 'image/png' : 'image/jpeg';
}

async function parseImageResponse(response, model) {
  const contentType = response.headers.get('content-type') || '';
  const buffer = Buffer.from(await response.arrayBuffer());
  if (contentType.startsWith('image/') || looksLikeImage(buffer)) return buffer;

  const text = buffer.toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderError(`Unexpected response from HF model "${model}": ${text.slice(0, 300)}`, { provider: ID, model });
  }
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  for (const entry of candidates) {
    const base64 = entry && (entry.generated_image || entry.image || entry.output || entry.b64_json);
    if (typeof base64 === 'string' && base64.length > 0) return Buffer.from(base64, 'base64');
  }
  throw new ProviderError(`HF model "${model}" returned JSON without an image field: ${text.slice(0, 300)}`, { provider: ID, model });
}

function taggedError(message, stageName) {
  const err = new ProviderError(message, { provider: ID });
  err.stage = stageName;
  return err;
}

module.exports = { id: ID, version: VERSION, supports, run };
