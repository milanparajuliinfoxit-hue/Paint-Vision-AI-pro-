/**
 * Hosted house-understanding provider ("replicate-vision").
 *
 * Two chained Replicate-hosted model calls stand in for the deleted local
 * Grounding DINO + SAM2 service (backend/vision-service/, removed in commit
 * 8c2c675 — recovered via git history, see AI_HOSTED_ARCHITECTURE.md §2):
 *
 *   1. adirik/grounding-dino — open-vocabulary text-prompted box detection.
 *      Input/output schema confirmed from source (replicate/cog-grounding-dino).
 *   2. meta/sam-2            — box-prompted pixel segmentation.
 *      Its exact box-prompt field name could NOT be confirmed from source
 *      before a live API token existed (see module-level UNVERIFIED note
 *      below and AI_HOSTED_ARCHITECTURE.md §5) — segmentClass() degrades to
 *      a rectangular bbox mask rather than failing outright if the guess is
 *      wrong or the call errors, and tags the degradation visibly.
 *
 * All of the geometric post-processing below (per-class confidence
 * thresholds, ambiguous-phrase rejection, roof geometric clamp, trim/gutter
 * derivation, wall banding, color/style/material extraction) is the *same*
 * heuristics the deleted local pipeline used, ported from Python/numpy to
 * JS — it's pure geometry over whatever masks come back, not tied to where
 * they came from.
 *
 * Output matches the app's existing house-understanding contract exactly
 * (see mockProvider.js / houseUnderstanding.service.js) — no downstream
 * code changes needed to consume this provider's output.
 *
 * UNVERIFIED until the first real API call (REPLICATE_API_TOKEN required,
 * not yet available as of this writing):
 *   - meta/sam-2's box-prompt input field name (REPLICATE_SAM_BOX_FIELD,
 *     defaults to a best-effort guess — see segmentClass/parseSamOutput).
 *   - Real end-to-end latency and segmentation quality on real house photos.
 * Do not treat this provider as "working" until that first call succeeds
 * and a real photo has been checked — see AI_HOSTED_ARCHITECTURE.md §5/§8.
 */
const Jimp = require('jimp');
const aiConfig = require('../../../config/aiConfig');
const { runPrediction, resolveVersionId } = require('../../providers/replicateClient');
const { ProviderError, getWithLimits } = require('../../providers/httpClient');
const logger = require('../../logger.service');
const { PROMPT_CLASSES, CLASS_THRESHOLDS, buildAnalysis } = require('../houseSceneNormalizer');

const ID = 'replicate-vision';
const VERSION = 'replicate-grounding-dino-sam2-v1';

const DINO_MODEL = process.env.REPLICATE_DINO_MODEL || 'adirik/grounding-dino';
const SAM_MODEL = process.env.REPLICATE_SAM_MODEL || 'meta/sam-2';
// Best-effort guess, mirrors the deleted local pipeline's own
// `sam_processor(images=image, input_boxes=[boxes])` call — unverified on
// Replicate's hosted listing specifically. Override via env if a live call
// reveals a different field name, without touching code.
const SAM_BOX_FIELD = process.env.REPLICATE_SAM_BOX_FIELD || 'input_boxes';

const DETECT_QUERY = PROMPT_CLASSES.join(', ');
const BOX_THRESHOLD = 0.15;
const TEXT_THRESHOLD = 0.25;

function supports(capability) {
  return capability === 'house-understanding';
}

async function run(capability, input) {
  if (!supports(capability)) {
    throw new Error(`replicate-vision provider does not support capability "${capability}"`);
  }
  const token = (process.env.REPLICATE_API_TOKEN || '').trim();
  if (!token) {
    throw taggedError('REPLICATE_API_TOKEN is missing — see backend/.env.example', 'config');
  }

  const timeouts = {
    createTimeoutMs: Number(process.env.AI_VISION_TIMEOUT_MS) || 60000,
    pollIntervalMs: Number(process.env.AI_REPLICATE_POLL_INTERVAL_MS) || 1500,
    pollTimeoutMs: Number(process.env.AI_REPLICATE_POLL_TIMEOUT_MS) || 45000,
  };

  const runStarted = Date.now();
  const { dataUri, width, height, scale, rgba } = await stage('prepare', () => prepareImage(input.buffer));

  const N = width * height;

  const detectStarted = Date.now();
  const rawDetections = await stage('detect', () => detect({ token, dataUri, ...timeouts }));
  const detections = filterDetections(rawDetections);
  const byClass = groupByClass(detections);
  logger.info({
    provider: ID, stage: 'detect', durationMs: Date.now() - detectStarted,
    rawDetections: rawDetections.length, acceptedDetections: detections.length,
    classes: Object.keys(byClass),
  });

  const segmentStarted = Date.now();
  // segmentClass already catches its own per-class provider errors and
  // degrades to a bbox-fallback mask (§4/§5 of AI_HOSTED_ARCHITECTURE.md) —
  // an error surfacing past this loop means something unexpected (a real
  // bug), not a normal provider hiccup, so it's tagged distinctly from
  // 'detect'/'segment'-as-provider-failure.
  const masks = await stage('segment', async () => {
    const out = {};
    for (const cls of PROMPT_CLASSES) {
      const items = byClass[cls] || [];
      out[cls] = items.length
        ? await segmentClass({ token, dataUri, items, width, height, ...timeouts })
        : { mask: new Uint8Array(N), confidence: 0, source: 'none' };
    }
    return out;
  });
  logger.info({
    provider: ID, stage: 'segment', durationMs: Date.now() - segmentStarted,
    // per-class source lets a caller see sam2-vs-bbox-fallback degradation
    // (§4/§5 of AI_HOSTED_ARCHITECTURE.md) without re-deriving it from output.
    sources: Object.fromEntries(PROMPT_CLASSES.map((c) => [c, masks[c].source])),
  });

  const output = await stage('normalize', () => buildAnalysis({ masks, width, height, rgba, N, scale }));
  logger.info({ provider: ID, stage: 'total', durationMs: Date.now() - runStarted, housePresent: output.house.present });

  // Real resolved version hashes, not just the static VERSION label (§19 —
  // "grounding-dino"/"sam-2" alone isn't sufficient reproducibility
  // metadata). Both are already cached by the detect()/segmentClass() calls
  // above, so this never triggers a real network call in the normal path —
  // resolveVersionId only does real I/O on a genuine cache miss.
  const dinoVersion = await resolveVersionId(token, DINO_MODEL, ID).catch(() => null);
  const samUsed = Object.values(masks).some((m) => m.source === 'sam2' || m.source === 'bbox-fallback');
  const samVersion = samUsed ? await resolveVersionId(token, SAM_MODEL, ID).catch(() => null) : null;
  const modelVersion = dinoVersion
    ? `grounding-dino@${dinoVersion.slice(0, 12)}${samVersion ? `+sam-2@${samVersion.slice(0, 12)}` : ''}`
    : VERSION;

  return { output, confidence: output.house.confidence, modelVersion };
}

// Runs `fn`, tagging any thrown error with which pipeline stage produced it
// (governing brief §17/§18 — structured failures need a `stage`, not just a
// message) without changing the error's type/message/other fields.
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
// Image prep

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
// Stage 1: detection

async function detect({ token, dataUri, createTimeoutMs, pollIntervalMs, pollTimeoutMs }) {
  const output = await runPrediction({
    token,
    model: DINO_MODEL,
    input: { image: dataUri, query: DETECT_QUERY, box_threshold: BOX_THRESHOLD, text_threshold: TEXT_THRESHOLD },
    providerName: ID,
    createTimeoutMs,
    pollIntervalMs,
    pollTimeoutMs,
  });
  const detections = Array.isArray(output?.detections) ? output.detections : [];
  return detections
    .map((d) => ({
      label: String(d.label || '').trim().toLowerCase(),
      confidence: Number(d.confidence) || 0,
      bbox: Array.isArray(d.bbox) ? d.bbox.map(Number) : null,
    }))
    .filter((d) => d.bbox && d.bbox.length === 4 && d.bbox.every(Number.isFinite));
}

// A joint multi-class prompt can make the detector return a merged phrase
// ("roof sky") whose box spans multiple concepts — discard anything
// ambiguous rather than attributing it to one class. Ported unchanged from
// the deleted local pipeline.
function filterDetections(detections) {
  const out = [];
  for (const d of detections) {
    const matches = PROMPT_CLASSES.filter((c) => d.label.includes(c));
    if (matches.length !== 1) continue;
    const cls = matches[0];
    const minScore = CLASS_THRESHOLDS[cls] ?? 0.3;
    if (d.confidence < minScore) continue;
    out.push({ ...d, class: cls });
  }
  return out;
}

function groupByClass(detections) {
  const byClass = {};
  for (const d of detections) {
    (byClass[d.class] = byClass[d.class] || []).push(d);
  }
  return byClass;
}

// ---------------------------------------------------------------------------
// Stage 2: segmentation (+ bbox-fallback degradation)

async function segmentClass({ token, dataUri, items, width, height, createTimeoutMs, pollIntervalMs, pollTimeoutMs }) {
  const boxes = items.map((it) => it.bbox);
  const confidence = Math.max(...items.map((it) => it.confidence));
  try {
    const output = await runPrediction({
      token,
      model: SAM_MODEL,
      input: { image: dataUri, [SAM_BOX_FIELD]: boxes },
      providerName: ID,
      createTimeoutMs,
      pollIntervalMs,
      pollTimeoutMs,
    });
    const mask = await parseSamOutput(output, width, height);
    if (!mask) throw new Error('unrecognized SAM2 output shape');
    return { mask, confidence, source: 'sam2' };
  } catch (err) {
    return { mask: rasterizeBoxes(boxes, width, height), confidence: confidence * 0.6, source: 'bbox-fallback', fallbackReason: err.message };
  }
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

// SAM2's exact output shape on Replicate is unverified (see module header).
// Tries the shapes a Cog segmentation model plausibly returns (an array of
// mask-image URLs, or one under `masks`/`output`) and returns null for
// anything else — the caller treats null as "fall back", never guesses
// further or fabricates a mask.
async function parseSamOutput(output, width, height) {
  const urls = Array.isArray(output) ? output : (output?.masks || output?.output || null);
  if (!Array.isArray(urls) || !urls.length || urls.some((u) => typeof u !== 'string')) return null;

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
  // exported for pure-logic unit tests (no network) — see replicateVisionProvider.test.js
  filterDetections,
  groupByClass,
  buildAnalysis,
  rasterizeBoxes,
  parseSamOutput,
};
