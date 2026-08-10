/**
 * Hosted house-understanding provider ("fal-vision") — SAM 3 on fal.ai.
 *
 * Replaces the two-stage Grounding DINO + SAM2 pipeline (replicateVisionProvider.js,
 * still registered and selectable — see AI_HOSTED_ARCHITECTURE.md §9) with a
 * single-model, single-call-per-class pipeline: `fal-ai/sam-3/image` is
 * Meta's SAM 3 (native open-vocabulary, concept-based text-to-mask
 * segmentation — released Nov 2025), officially hosted on fal.ai. One call
 * per class in PROMPT_CLASSES returns that class's instances directly as
 * masks + confidence scores + boxes — no separate detector, no box-handoff
 * between two different models, no guessing a second model's input schema.
 *
 * Why this over sticking with Replicate's Grounding DINO + SAM2:
 *   - SAM 3 understands text concepts and produces pixel masks in one model,
 *     one call — simpler pipeline, per AI_HOSTED_ARCHITECTURE.md §9's own
 *     "prefer the simpler pipeline if one model can do both jobs" guidance.
 *   - Official `fal-ai/sam-3` listing exists (unlike Replicate, where only
 *     unverified community SAM-3 wrappers existed at evaluation time).
 *   - Input/output schema is CONFIRMED from fal's own API reference (not a
 *     guess) — see AI_HOSTED_ARCHITECTURE.md §9 for the citations. The one
 *     remaining unverified assumption is narrower than Replicate's ever was:
 *     whether `image_url` accepts a data: URI directly (every other hosted
 *     model this app has integrated does) or requires fal's own upload
 *     step first — flagged for the first live call to confirm.
 *
 * Output matches the app's existing house-understanding contract exactly
 * (see houseSceneNormalizer.js / houseUnderstanding.service.js) — no
 * downstream code changes needed to consume this provider's output.
 */
const Jimp = require('jimp');
const aiConfig = require('../../../config/aiConfig');
const { runModel } = require('../../providers/falClient');
const { ProviderError, getWithLimits } = require('../../providers/httpClient');
const logger = require('../../logger.service');
const { PROMPT_CLASSES, CLASS_THRESHOLDS, buildAnalysis } = require('../houseSceneNormalizer');

const ID = 'fal-vision';
const VERSION = 'fal-sam3-v1';

const SAM3_MODEL = process.env.FAL_SAM3_MODEL || 'fal-ai/sam-3/image';
const MAX_MASKS_PER_CLASS = Number(process.env.FAL_MAX_MASKS_PER_CLASS) || 3;

function supports(capability) {
  return capability === 'house-understanding';
}

async function run(capability, input) {
  if (!supports(capability)) {
    throw new Error(`fal-vision provider does not support capability "${capability}"`);
  }
  const apiKey = (process.env.FAL_API_KEY || '').trim();
  if (!apiKey) {
    throw taggedError('FAL_API_KEY is missing — see backend/.env.example', 'config');
  }

  const timeouts = {
    createTimeoutMs: Number(process.env.AI_VISION_TIMEOUT_MS) || 60000,
    pollIntervalMs: Number(process.env.AI_FAL_POLL_INTERVAL_MS) || 1500,
    pollTimeoutMs: Number(process.env.AI_FAL_POLL_TIMEOUT_MS) || 45000,
  };

  const runStarted = Date.now();
  const { dataUri, width, height, scale, rgba } = await stage('prepare', () => prepareImage(input.buffer));
  const N = width * height;

  // One call per class — detection and segmentation are the same call here,
  // so there's no separate detect/segment split the way Replicate's
  // two-model pipeline needed. Kept under a single 'segment' stage label so
  // aiResult's stage field stays comparable across providers.
  const segmentStarted = Date.now();
  const masks = await stage('segment', async () => {
    const out = {};
    for (const cls of PROMPT_CLASSES) {
      out[cls] = await segmentClass({ apiKey, dataUri, cls, width, height, ...timeouts });
    }
    return out;
  });
  logger.info({
    provider: ID, stage: 'segment', durationMs: Date.now() - segmentStarted,
    sources: Object.fromEntries(PROMPT_CLASSES.map((c) => [c, masks[c].source])),
  });

  const output = await stage('normalize', () => buildAnalysis({ masks, width, height, rgba, N, scale }));
  logger.info({ provider: ID, stage: 'total', durationMs: Date.now() - runStarted, housePresent: output.house.present });

  return { output, confidence: output.house.confidence, modelVersion: `sam-3@${SAM3_MODEL}` };
}

async function stage(name, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err && typeof err === 'object' && !err.stage) err.stage = name;
    throw err;
  }
}

function taggedError(message, stageName) {
  const err = new ProviderError(message, { provider: ID });
  err.stage = stageName;
  return err;
}

// ---------------------------------------------------------------------------
// Image prep — identical convention to replicateVisionProvider.js
// (AI_ANALYSIS_MAX_DIM downscale, data: URI so no separate upload step is
// needed if fal accepts it directly — see module header's flagged assumption).

async function prepareImage(buffer) {
  const image = await Jimp.read(buffer);
  const maxDim = aiConfig.getAnalysisMaxDim() || 640;
  const scale = Math.min(1, maxDim / Math.max(image.getWidth(), image.getHeight()));
  if (scale < 1) {
    image.resize(Math.max(1, Math.round(image.getWidth() * scale)), Math.max(1, Math.round(image.getHeight() * scale)));
  }
  const width = image.getWidth();
  const height = image.getHeight();
  const png = await image.getBufferAsync(Jimp.MIME_PNG);
  const dataUri = `data:image/png;base64,${png.toString('base64')}`;
  return { dataUri, width, height, scale, rgba: image.bitmap.data };
}

// ---------------------------------------------------------------------------
// Per-class detect+segment (SAM 3 does both in one call)

async function segmentClass({ apiKey, dataUri, cls, width, height, createTimeoutMs, pollIntervalMs, pollTimeoutMs }) {
  const minScore = CLASS_THRESHOLDS[cls] ?? 0.3;
  const empty = () => ({ mask: new Uint8Array(width * height), confidence: 0, source: 'none' });

  let output;
  try {
    output = await runModel({
      apiKey,
      model: SAM3_MODEL,
      input: {
        image_url: dataUri,
        prompt: cls,
        return_multiple_masks: true,
        max_masks: MAX_MASKS_PER_CLASS,
        include_scores: true,
        include_boxes: true,
        output_format: 'png',
      },
      providerName: ID,
      createTimeoutMs,
      pollIntervalMs,
      pollTimeoutMs,
    });
  } catch (err) {
    return { ...empty(), fallbackReason: err.message };
  }

  const scores = Array.isArray(output?.scores) ? output.scores.map(Number) : [];
  const maskImages = Array.isArray(output?.masks) ? output.masks : [];
  const boxesNorm = Array.isArray(output?.boxes) ? output.boxes : [];

  const survivingIdx = scores
    .map((s, i) => [s, i])
    .filter(([s]) => Number.isFinite(s) && s >= minScore)
    .map(([, i]) => i);
  if (!survivingIdx.length) return empty();

  const confidence = Math.max(...survivingIdx.map((i) => scores[i]));

  try {
    const urls = survivingIdx.map((i) => maskImages[i]?.url).filter((u) => typeof u === 'string');
    if (!urls.length) throw new Error('no mask URLs in response for surviving detections');
    const mask = await unionMaskUrls(urls, width, height);
    return { mask, confidence, source: 'sam-3' };
  } catch (err) {
    // Degrade to the returned boxes rather than failing the whole analysis —
    // same "never a silent empty/full mask, always a visible degradation"
    // rule replicateVisionProvider.js's bbox-fallback follows.
    const boxesPx = survivingIdx.map((i) => denormalizeBox(boxesNorm[i], width, height)).filter(Boolean);
    if (!boxesPx.length) return { ...empty(), fallbackReason: err.message };
    return { mask: rasterizeBoxes(boxesPx, width, height), confidence: confidence * 0.6, source: 'bbox-fallback', fallbackReason: err.message };
  }
}

// [cx, cy, w, h] normalized (0..1) -> [x0, y0, x1, y1] pixels — SAM 3's
// documented box format (fal-ai/sam-3/image API reference).
function denormalizeBox(box, W, H) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const [cx, cy, w, h] = box.map(Number);
  if (![cx, cy, w, h].every(Number.isFinite)) return null;
  return [(cx - w / 2) * W, (cy - h / 2) * H, (cx + w / 2) * W, (cy + h / 2) * H];
}

function rasterizeBoxes(boxes, W, H) {
  const mask = new Uint8Array(W * H);
  for (const box of boxes) {
    const [x0, y0, x1, y1] = box;
    const xs = Math.max(0, Math.round(Math.min(x0, x1))), xe = Math.min(W - 1, Math.round(Math.max(x0, x1)));
    const ys = Math.max(0, Math.round(Math.min(y0, y1))), ye = Math.min(H - 1, Math.round(Math.max(y0, y1)));
    for (let y = ys; y <= ye; y++) {
      const base = y * W;
      for (let x = xs; x <= xe; x++) mask[base + x] = 1;
    }
  }
  return mask;
}

// Downloads each mask image and ORs them into one boolean mask at
// (width,height) — a class can have multiple instances (return_multiple_masks).
async function unionMaskUrls(urls, width, height) {
  const mask = new Uint8Array(width * height);
  for (const url of urls) {
    const buf = await getWithLimits(url, { timeoutMs: 15000, maxBytes: 10 * 1024 * 1024, provider: ID });
    const maskImg = await Jimp.read(buf);
    if (maskImg.getWidth() !== width || maskImg.getHeight() !== height) maskImg.resize(width, height);
    maskImg.scan(0, 0, width, height, (x, y, idx) => {
      const i = y * width + x;
      const alpha = maskImg.bitmap.data[idx + 3];
      const lum = (maskImg.bitmap.data[idx] + maskImg.bitmap.data[idx + 1] + maskImg.bitmap.data[idx + 2]) / 3;
      if (alpha > 127 || lum > 127) mask[i] = 1;
    });
  }
  return mask;
}

module.exports = {
  id: ID,
  version: VERSION,
  supports,
  run,
  // exported for pure-logic unit tests (no network)
  denormalizeBox,
  rasterizeBoxes,
};
