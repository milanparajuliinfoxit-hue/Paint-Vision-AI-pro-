/**
 * Generic HTTP vision provider — the "bring your own model" path.
 *
 * Posts the image to a configurable endpoint (any vision model wrapped behind
 * a thin API) and expects the SAME structured JSON the mock provider emits:
 *
 *   {
 *     "house":     { "present", "bbox", "style", "material", "color", "confidence" },
 *     "surfaces":  [ { "key", "className", "displayName", "paintable", "role",
 *                      "confidence", "mask": { "width","height","alpha": [...] },
 *                      "geometry": { "bbox" }, "averageColor" } ],
 *     "objects":   [ { "key", "className", "displayName", "paintable",
 *                      "confidence", "mask", "geometry" } ],
 *     "context":   { "skyColor", "groundColor", "roofColor", "wallColor",
 *                    "lighting", "palette" }
 *   }
 *
 * That contract is what makes real providers drop-in: swap AI_ANALYSIS_PROVIDER
 * and the rest of the system is untouched.
 *
 * Env:
 *   AI_VISION_URL      - required. Endpoint that accepts a JSON POST.
 *   AI_VISION_API_KEY  - optional. Sent as Bearer token.
 *   AI_VISION_MODEL    - optional, recorded as modelVersion in the job.
 *   AI_VISION_TIMEOUT_MS - optional, default 60000.
 */
const Jimp = require('jimp');

const ID = 'http-vision';
const VERSION = 'http-vision-v1';

function supports(capability) {
  return capability === 'house-understanding';
}

async function run(capability, input) {
  if (!supports(capability)) {
    throw new Error(`http-vision provider does not support capability "${capability}"`);
  }
  return { output: await callVision(input.buffer), confidence: 1, modelVersion: process.env.AI_VISION_MODEL || VERSION };
}

async function callVision(buffer) {
  const url = process.env.AI_VISION_URL;
  if (!url) {
    throw new Error('AI_VISION_URL is not set — configure it to use the http-vision provider.');
  }

  const image = await Jimp.read(buffer);
  const png = await image.getBufferAsync(Jimp.MIME_PNG);
  const dataUri = `data:image/png;base64,${png.toString('base64')}`;

  const controller = new AbortController();
  const timeoutMs = Number(process.env.AI_VISION_TIMEOUT_MS) || 60000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.AI_VISION_API_KEY ? { Authorization: `Bearer ${process.env.AI_VISION_API_KEY}` } : {}),
      },
      body: JSON.stringify({ image: dataUri, task: 'house-understanding' }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Vision provider responded ${res.status}: ${detail.slice(0, 300)}`);
    }
    const body = await res.json();
    const output = body.output || body.result || body;
    validateOutput(output);
    return output;
  } finally {
    clearTimeout(timer);
  }
}

function validateOutput(output) {
  const required = ['house', 'surfaces', 'objects', 'context'];
  for (const key of required) {
    if (output[key] === undefined) {
      throw new Error(`Vision provider output is missing "${key}". Expected the mock-provider schema.`);
    }
  }
}

module.exports = { id: ID, version: VERSION, supports, run };
