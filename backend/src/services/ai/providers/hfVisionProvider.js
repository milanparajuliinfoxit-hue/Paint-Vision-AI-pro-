/**
 * Hosted Grounded-SAM2 house-understanding provider ("hf-vision").
 *
 * Replaces the local backend/vision-service with the same two-stage pipeline
 * run against Hugging Face Inference Providers:
 *
 *   1. Grounding DINO (zero-shot-object-detection) -> labeled boxes for the
 *      architectural parts and obstructions in the photo.
 *   2. SAM 2 (image-segmentation, box-prompted)     -> one pixel mask per box.
 *
 * Raw class masks then go through the pure geometric assembly in
 * ../visionAssembly.js (the JS port of the local pipeline's post-processing),
 * which produces the app's exact house-understanding contract — so the
 * backend, DB and frontend see the identical output shape as `mock`.
 *
 * Keys are backend-only (HF_API_KEY, Bearer). No model code runs here and no
 * key ever reaches the browser.
 *
 * Env (all optional except HF_API_KEY, which is already used by cleanup):
 *   AI_ANALYSIS_PROVIDER=hf-vision        - activate this provider
 *   AI_VISION_DETECTOR_MODEL              - default IDEA-Research/grounding-dino-tiny
 *   AI_VISION_SEGMENTOR_MODEL             - default facebook/sam2-hiera-base
 *   AI_ANALYSIS_MAX_DIM                   - downscale long edge (default 640)
 *   AI_VISION_TIMEOUT_MS                  - per-call timeout (default 60000)
 *   AI_VISION_MODEL                       - recorded as modelVersion in the job
 *
 * NOTE (live smoke test): the exact HF parameter names for the segmentor
 * (SAM 2 box prompting) vary between deployments — see the inline comments.
 * The assembly side is verified offline by `npm run smoke:vision`.
 */
const Jimp = require('jimp');
const { post, ProviderError } = require('../../providers/httpClient');
const { assembleContract } = require('../visionAssembly');

const ID = 'hf-vision';
const VERSION = 'hf-grounded-sam-v1';
const DEFAULT_MAX_DIM = 640;

const PROMPT_CLASSES = ['roof', 'wall', 'window', 'door', 'tree', 'car', 'person', 'fence', 'sky', 'ground'];

// Matches pipeline.py CLASS_THRESHOLDS — large structural surfaces (walls,
// roof, sky, ground) score lower than compact distinctive objects.
const CLASS_THRESHOLDS = {
  roof: 0.2, wall: 0.15, window: 0.3, door: 0.25,
  tree: 0.3, car: 0.3, person: 0.3, fence: 0.3,
  sky: 0.15, ground: 0.15,
};

const ROUTER_BASE = 'https://router.huggingface.co/hf-inference/models';

function supports(capability) {
  return capability === 'house-understanding';
}

async function run(capability, input) {
  if (!supports(capability)) {
    throw new Error(`hf-vision provider does not support capability "${capability}"`);
  }
  return { output: await analyze(input.buffer), confidence: 1, modelVersion: process.env.AI_VISION_MODEL || VERSION };
}

async function analyze(buffer) {
  const apiKey = (process.env.HF_API_KEY || '').trim();
  if (!apiKey) {
    throw new ProviderError('HF_API_KEY is missing — the hf-vision provider needs it (see .env.example)', { provider: ID });
  }

  const detectorModel = (process.env.AI_VISION_DETECTOR_MODEL || 'IDEA-Research/grounding-dino-tiny').trim();
  const segmentorModel = (process.env.AI_VISION_SEGMENTOR_MODEL || 'facebook/sam2-hiera-base').trim();
  const timeoutMs = Number(process.env.AI_VISION_TIMEOUT_MS) || 60000;

  const image = await Jimp.read(buffer);
  const maxDim = Number(process.env.AI_ANALYSIS_MAX_DIM) || DEFAULT_MAX_DIM;
  const scale = Math.min(1, maxDim / Math.max(image.getWidth(), image.getHeight()));
  if (scale < 1) {
    image.resize(
      Math.max(1, Math.round(image.getWidth() * scale)),
      Math.max(1, Math.round(image.getHeight() * scale))
    );
  }
  const W = image.getWidth();
  const H = image.getHeight();
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    rgb[i * 3] = image.bitmap.data[o];
    rgb[i * 3 + 1] = image.bitmap.data[o + 1];
    rgb[i * 3 + 2] = image.bitmap.data[o + 2];
  }

  const detections = await detectBoxes({ image, apiKey, detectorModel, timeoutMs });
  const masks = await segmentBoxes({ image, apiKey, segmentorModel, timeoutMs, detections });

  const classMasks = {};
  const classConfidences = {};
  for (const cls of PROMPT_CLASSES) classMasks[cls] = new Uint8Array(W * H);

  for (let i = 0; i < detections.length; i++) {
    const det = detections[i];
    const mask = masks[i];
    if (!mask) continue;
    const target = classMasks[det.class];
    for (let p = 0; p < mask.length; p++) target[p] = target[p] || mask[p];
    classConfidences[det.class] = Math.max(classConfidences[det.class] || 0, det.score);
  }

  return assembleContract({ width: W, height: H, rgb, classMasks, classConfidences, scale });
}

// ---------------------------------------------------------------------------
// Model calls (HF Inference Providers)

async function imageDataUri(image) {
  const png = await image.getBufferAsync(Jimp.MIME_PNG);
  return png.toString('base64');
}

/**
 * Step 1 — Grounding DINO, zero-shot-object-detection.
 * Response: [{ score, label, box: { xmin, ymin, xmax, ymax } }]
 */
async function detectBoxes({ image, apiKey, detectorModel, timeoutMs }) {
  const url = `${ROUTER_BASE}/${detectorModel}`;
  const body = JSON.stringify({
    inputs: await imageDataUri(image),
    parameters: { text_queries: PROMPT_CLASSES },
  });

  const response = await post({
    url,
    provider: ID,
    model: detectorModel,
    timeoutMs,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body,
  });

  const payload = await response.json();
  const results = Array.isArray(payload) ? payload : payload.output;
  if (!Array.isArray(results)) {
    throw new ProviderError(`Detector "${detectorModel}" returned an unexpected payload shape.`, {
      provider: ID,
      model: detectorModel,
    });
  }

  // Same filtering as pipeline.py _detect: only unambiguous single-concept
  // phrases survive (compound phrases like "roof sky" are dropped), then the
  // per-class confidence threshold applies.
  const detections = [];
  for (const r of results) {
    const label = String(r.label || '').trim().toLowerCase();
    const matches = PROMPT_CLASSES.filter((cls) => label.includes(cls));
    if (matches.length !== 1) continue;
    const cls = matches[0];
    const score = Number(r.score) || 0;
    if (score < Math.max(0.15, CLASS_THRESHOLDS[cls])) continue;
    const box = r.box || {};
    detections.push({
      class: cls,
      score,
      box: [Number(box.xmin) || 0, Number(box.ymin) || 0, Number(box.xmax) || 0, Number(box.ymax) || 0],
    });
  }
  return detections;
}

/**
 * Step 2 — SAM 2, image-segmentation with box prompts.
 * Response: array aligned with the input boxes, each entry carrying a mask:
 *   [{ label, score, mask: "<base64 PNG>" }]   (hf-inference style)
 */
async function segmentBoxes({ image, apiKey, segmentorModel, timeoutMs, detections }) {
  if (detections.length === 0) return [];

  const url = `${ROUTER_BASE}/${segmentorModel}`;
  const boxes = detections.map((d) => d.box);
  // Every box is a positive (foreground) prompt for the class that produced it.
  const inputLabels = detections.map(() => 1);
  const body = JSON.stringify({
    inputs: await imageDataUri(image),
    parameters: {
      input_boxes: boxes,
      input_labels: inputLabels,
      multimask_output: false,
    },
  });

  const response = await post({
    url,
    provider: ID,
    model: segmentorModel,
    timeoutMs,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body,
  });

  const payload = await response.json();
  const entries = Array.isArray(payload) ? payload : payload.output;
  if (!Array.isArray(entries)) {
    throw new ProviderError(`Segmentor "${segmentorModel}" returned an unexpected payload shape.`, {
      provider: ID,
      model: segmentorModel,
    });
  }

  const masks = [];
  for (const entry of entries) {
    const raw = entry && (entry.mask || entry.masks);
    if (typeof raw === 'string' && raw.length > 0) {
      masks.push(await decodeMaskPng(raw));
    } else if (entry && Array.isArray(entry.masks)) {
      masks.push(await decodeMaskPng(entry.masks[0]));
    }
  }
  return masks;
}

// Base64 grayscale/alpha PNG -> Uint8Array 0/1 mask at the image resolution.
async function decodeMaskPng(base64) {
  let pngBuffer;
  try {
    pngBuffer = Buffer.from(base64, 'base64');
  } catch {
    throw new ProviderError('Segmentor returned a mask that is not valid base64.', { provider: ID });
  }
  let maskImage;
  try {
    maskImage = await Jimp.read(pngBuffer);
  } catch {
    throw new ProviderError('Segmentor returned a mask that is not a decodable PNG.', { provider: ID });
  }
  const mask = new Uint8Array(maskImage.getWidth() * maskImage.getHeight());
  maskImage.scan(0, 0, maskImage.getWidth(), maskImage.getHeight(), (x, y, idx) => {
    mask[y * maskImage.getWidth() + x] = maskImage.bitmap.data[idx + 3] > 127 ? 1 : 0;
  });
  return mask;
}

module.exports = { id: ID, version: VERSION, supports, run };
