/**
 * Hosted house-visualization provider ("gemini-image") — Gemini native image
 * generation/editing (ai.google.dev/gemini-api/docs/image-generation), per
 * GEMINI_RECOLORING_IMPLEMENTATION_PLAN.md Phase 3.
 *
 * NOT YET LIVE-VALIDATED. `house-visualization` is a new capability — there
 * is no prior provider for it to be compared against (unlike gemini-vision,
 * which has fal-vision/replicate-vision as precedent). Registering this
 * requires a real Phase 1 test before AI_VISUALIZATION_PROVIDER is set to
 * anything in a real environment; aiConfig.js has no default provider for
 * this capability for exactly that reason (mirrors the existing
 * house-understanding "no default until configured" convention).
 *
 * Input contract: { buffer (original photo), prompt (pre-built by
 * visualizationPrompt.service.js or houseIsolationPrompt.service.js — this
 * provider never builds prompt text itself, so it can never be handed raw
 * user input). Output: a generated image Buffer.
 *
 * Also backs the 'house-isolation' capability (Section 2 of the governing
 * brief) — same generic "image in, edited image out" Gemini call, just a
 * different fixed prompt from a different builder. No provider-level branch
 * needed; the prompt is the only thing that differs per capability.
 */
const { post, ProviderError } = require('../../providers/httpClient');
const logger = require('../../logger.service');

const ID = 'gemini-image';
const VERSION = 'gemini-image-v1';

const MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

function supports(capability) {
  return capability === 'house-visualization' || capability === 'house-isolation';
}

async function run(capability, input) {
  if (!supports(capability)) {
    throw new Error(`gemini-image provider does not support capability "${capability}"`);
  }
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    throw taggedError('GEMINI_API_KEY is missing — see backend/.env.example', 'config');
  }
  if (!input?.prompt) {
    throw taggedError('No prompt provided — visualizationPrompt.service.js must build one first', 'config');
  }

  const timeoutEnvVar = capability === 'house-isolation' ? 'AI_ISOLATION_TIMEOUT_MS' : 'AI_VISUALIZATION_TIMEOUT_MS';
  const timeoutMs = Number(process.env[timeoutEnvVar]) || 90000;
  const started = Date.now();

  const mimeType = input.mimeType || 'image/jpeg';
  const imageB64 = Buffer.isBuffer(input.buffer) ? input.buffer.toString('base64') : input.buffer;

  const response = await post({
    url: `${BASE_URL}/${MODEL}:generateContent?key=${apiKey}`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: input.prompt },
          { inline_data: { mime_type: mimeType, data: imageB64 } },
          ...(input.referenceImages || []).map((ref) => ({
            inline_data: { mime_type: ref.mimeType || 'image/png', data: Buffer.isBuffer(ref.buffer) ? ref.buffer.toString('base64') : ref.buffer },
          })),
        ],
      }],
    }),
    provider: ID,
    model: MODEL,
    timeoutMs,
  });

  const json = await response.json();
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p) => p.inline_data || p.inlineData);
  if (!imagePart) {
    // Gemini can refuse/return text-only for safety or ambiguity reasons —
    // surface that as a real failure with whatever text it did return,
    // never silently produce an empty/placeholder image.
    const textPart = parts.find((p) => typeof p.text === 'string')?.text;
    throw taggedError(`Gemini returned no image data${textPart ? `: ${textPart.slice(0, 300)}` : ''}`, 'generate');
  }
  const inline = imagePart.inline_data || imagePart.inlineData;
  const outputBuffer = Buffer.from(inline.data, 'base64');

  const durationMs = Date.now() - started;
  logger.info({ provider: ID, stage: 'generate', durationMs, outputBytes: outputBuffer.length });

  return { output: { buffer: outputBuffer, mimeType: inline.mime_type || inline.mimeType || 'image/png' }, confidence: 1, modelVersion: MODEL };
}

function taggedError(message, stageName) {
  const err = new ProviderError(message, { provider: ID, model: MODEL });
  err.stage = stageName;
  return err;
}

module.exports = { id: ID, version: VERSION, supports, run };
