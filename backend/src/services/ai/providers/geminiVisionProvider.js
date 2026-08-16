/**
 * Hosted house-understanding provider ("gemini-vision") — Gemini native
 * object detection + segmentation (ai.google.dev/gemini-api/docs/
 * image-understanding), per GEMINI_RECOLORING_IMPLEMENTATION_PLAN.md Phase 2.
 *
 * NOT YET LIVE-VALIDATED. Built strictly against Google's documented
 * response schema:
 *   { "boxes": [ { "box_2d": [ymin,xmin,ymax,xmax], "mask": [[x,y],...], "label": "..." } ] }
 * (box_2d and mask points both normalized 0-1000). Per this project's "no
 * fake success" rule, do not register this as the default
 * AI_ANALYSIS_PROVIDER until Phase 1's real call against a real house photo
 * confirms this schema is what actually comes back — the fal-vision
 * provider's own header comment shows exactly this kind of documented-vs-
 * actual gap has bitten this codebase before.
 *
 * Unlike fal-vision/replicate-vision (houseSceneNormalizer.js), this
 * provider does NOT use the fixed 10-class-single-mask-per-class vocabulary
 * + geometric wall-banding post-processing pipeline. Gemini can directly
 * label distinct instances (front wall vs. left wall vs. balcony vs. gate as
 * separate polygons) in one pass, so deriving them geometrically the way
 * houseSceneNormalizer.js does for SAM3's single wall mask would throw away
 * information Gemini already gives us. It also satisfies the governing
 * brief's Section 8 requirement ("do not hard-code the system so only a
 * fixed surface list can ever exist") more directly — an unrecognized label
 * still becomes a visible, non-paintable-by-default surface instead of being
 * dropped.
 *
 * Output matches the app's existing house-understanding contract exactly
 * (houseUnderstanding.service.js) — same as every other registered provider.
 */
const Jimp = require('jimp');
const aiConfig = require('../../../config/aiConfig');
const { post, ProviderError } = require('../../providers/httpClient');
const logger = require('../../logger.service');
const geom = require('../maskGeometry');
const { box2dToPixels, polygonToPixels, rasterizePolygon, rasterizeBox } = require('../polygonMask.util');

const ID = 'gemini-vision';
const VERSION = 'gemini-understanding-v1';

const MODEL = process.env.GEMINI_UNDERSTANDING_MODEL || 'gemini-3.6-flash';
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// Suggested vocabulary passed to the model as a prompt hint, not a hard
// allow-list — the classifier below (classifyLabel) still accepts any label
// Gemini actually returns, defaulting unrecognized ones to a visible,
// non-paintable "other surface" rather than dropping them (Section 8).
const SUGGESTED_CLASSES = [
  'exterior wall', 'trim', 'fascia', 'soffit', 'roof', 'door', 'window',
  'window frame', 'window grill', 'railing', 'balcony', 'balcony wall',
  'pillar', 'column', 'staircase', 'gate', 'compound wall', 'boundary wall',
  'ceiling', 'tree', 'car', 'person', 'garden furniture',
];

// Priority-ordered (first match wins) substring rules mapping a Gemini
// label to this app's surface/object contract. Ordered so more specific
// phrases ("compound wall") are checked before broader ones that could
// otherwise false-match a substring of them.
const SURFACE_RULES = [
  { test: /compound wall|boundary wall/i, key: 'compound-wall', name: 'Compound Wall', paintable: true, role: 'boundary' },
  { test: /balcony wall/i, key: 'balcony-wall', name: 'Balcony Wall', paintable: true, role: 'balcony' },
  { test: /balcony/i, key: 'balcony', name: 'Balcony', paintable: true, role: 'balcony' },
  { test: /railing|balustrade|handrail/i, key: 'railing', name: 'Railing', paintable: true, role: 'railing' },
  { test: /gate/i, key: 'gate', name: 'Gate', paintable: true, role: 'gate' },
  { test: /pillar|column/i, key: 'pillar', name: 'Pillar', paintable: true, role: 'pillar' },
  { test: /staircase|stairs/i, key: 'staircase', name: 'Staircase', paintable: true, role: 'staircase' },
  { test: /fascia|soffit/i, key: 'trim', name: 'Trim', paintable: true, role: 'trim' },
  { test: /^trim$|trim board/i, key: 'trim', name: 'Trim', paintable: true, role: 'trim' },
  { test: /ceiling/i, key: 'ceiling', name: 'Ceiling', paintable: true, role: 'ceiling' },
  { test: /window frame|window grill/i, key: 'window-frame', name: 'Window Frame', paintable: true, role: 'trim' },
  { test: /window/i, key: 'windows', name: 'Windows', paintable: false, role: null },
  { test: /front door|garage door|^door$/i, key: 'door', name: 'Door', paintable: true, role: 'doors' },
  { test: /roof/i, key: 'roof', name: 'Roof', paintable: true, role: 'roof' },
  { test: /front wall/i, key: 'front-wall', name: 'Front wall', paintable: true, role: 'primary-wall' },
  { test: /left wall/i, key: 'left-wall', name: 'Left wall', paintable: true, role: 'accent-wall' },
  { test: /right wall/i, key: 'right-wall', name: 'Right wall', paintable: true, role: 'accent-wall' },
  { test: /exterior wall|facade|^wall$/i, key: 'front-wall', name: 'Wall', paintable: true, role: 'primary-wall' },
];

const OBJECT_RULES = [
  { test: /tree|plant|bush|shrub|hedge/i, key: 'tree', name: 'Tree' },
  { test: /\bcar\b|vehicle/i, key: 'car', name: 'Car' },
  { test: /\bperson\b|people/i, key: 'person', name: 'Person' },
  { test: /garden furniture|furniture/i, key: 'furniture', name: 'Garden furniture' },
  { test: /chain-link fence|wire fence/i, key: 'fence', name: 'Fence' },
];

let surfaceKeyCounts;

function classifyLabel(rawLabel) {
  const label = String(rawLabel || '').trim();
  if (!label) return null;
  for (const rule of SURFACE_RULES) {
    if (rule.test.test(label)) return { type: 'surface', ...rule };
  }
  for (const rule of OBJECT_RULES) {
    if (rule.test.test(label)) return { type: 'object', ...rule };
  }
  // Unrecognized label: keep it visible (Section 8 — no hard-coded closed
  // vocabulary) as a non-paintable "other" surface rather than dropping it
  // or guessing it's paintable.
  const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'other';
  return { type: 'surface', key: `other-${key}`, name: label, paintable: false, role: null };
}

function supports(capability) {
  return capability === 'house-understanding';
}

async function run(capability, input) {
  if (!supports(capability)) {
    throw new Error(`gemini-vision provider does not support capability "${capability}"`);
  }
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    throw taggedError('GEMINI_API_KEY is missing — see backend/.env.example', 'config');
  }

  const timeoutMs = Number(process.env.AI_VISION_TIMEOUT_MS) || 60000;
  const runStarted = Date.now();

  const { imageB64, width, height, scale, rgba } = await stage('prepare', () => prepareImage(input.buffer));

  const detections = await stage('detect', () => detectAndSegment({ apiKey, imageB64, width, height, timeoutMs }));

  const output = await stage('normalize', () => buildAnalysis({ detections, width, height, rgba, scale }));
  logger.info({ provider: ID, stage: 'total', durationMs: Date.now() - runStarted, housePresent: output.house.present, surfaceCount: output.surfaces.length, objectCount: output.objects.length });

  return { output, confidence: output.house.confidence, modelVersion: MODEL };
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
  const err = new ProviderError(message, { provider: ID, model: MODEL });
  err.stage = stageName;
  return err;
}

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
  return { imageB64: png.toString('base64'), width, height, scale, rgba: image.bitmap.data };
}

async function detectAndSegment({ apiKey, imageB64, width, height, timeoutMs }) {
  const prompt = [
    `Detect architectural exterior surfaces and removable obstructions in this house photo.`,
    `Look for (not limited to): ${SUGGESTED_CLASSES.join(', ')}.`,
    `For each detected item, output its bounding box and a segmentation mask`,
    `as a polygon of [x,y] points, normalized to a 0-1000 scale.`,
    `Respond as JSON only, matching this schema:`,
    `{ "boxes": [ { "box_2d": [ymin,xmin,ymax,xmax], "mask": [[x,y],...], "label": "string" } ] }`,
  ].join(' ');

  const response = await post({
    url: `${BASE_URL}/${MODEL}:generateContent?key=${apiKey}`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: 'image/png', data: imageB64 } },
        ],
      }],
      generationConfig: { responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'minimal' } },
    }),
    provider: ID,
    model: MODEL,
    timeoutMs,
  });

  const json = await response.json();
  const text = json?.candidates?.[0]?.content?.parts?.find((p) => typeof p.text === 'string')?.text;
  if (!text) throw taggedError('Gemini returned no text content for the detection request', 'detect');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw taggedError(`Gemini detection response was not valid JSON: ${err.message}`, 'detect');
  }
  const boxes = Array.isArray(parsed?.boxes) ? parsed.boxes : [];
  return boxes
    .map((b) => ({
      classification: classifyLabel(b.label),
      box: box2dToPixels(b.box_2d, width, height),
      polygon: polygonToPixels(b.mask, width, height),
      confidence: Number.isFinite(Number(b.confidence)) ? Number(b.confidence) : 0.5,
      label: b.label,
    }))
    .filter((d) => d.classification && (d.box || d.polygon));
}

function buildAnalysis({ detections, width: W, height: H, rgba, scale }) {
  const N = W * H;
  surfaceKeyCounts = new Map();

  const surfaces = [];
  const objects = [];
  let unionMask = new Uint8Array(N);
  let roofMask = null;
  let wallMaskForColor = null;

  for (const d of detections) {
    const mask = d.polygon ? rasterizePolygon(d.polygon, W, H) : rasterizeBox(d.box, W, H);
    if (geom.countOn(mask) === 0) continue;
    for (let i = 0; i < N; i++) if (mask[i]) unionMask[i] = 1;

    if (d.classification.type === 'object') {
      const key = dedupeKey(d.classification.key);
      objects.push({
        key,
        className: d.classification.key,
        displayName: d.classification.name,
        paintable: false,
        confidence: round3(d.confidence),
        mask: { width: W, height: H, alpha: geom.toAlpha255(mask) },
        geometry: { bbox: geom.maskBbox(mask, W, H), areaPx: geom.countOn(mask), areaRatio: geom.countOn(mask) / N },
      });
    } else {
      const key = dedupeKey(d.classification.key);
      surfaces.push({
        key,
        className: d.classification.key,
        displayName: d.classification.name,
        paintable: d.classification.paintable,
        role: d.classification.role,
        confidence: round3(d.confidence),
        mask: { width: W, height: H, alpha: geom.toAlpha255(mask) },
        geometry: { bbox: geom.maskBbox(mask, W, H), areaPx: geom.countOn(mask), areaRatio: geom.countOn(mask) / N },
        averageColor: geom.colorOfMask(rgba, mask),
        properties: d.classification.role ? { role: d.classification.role } : {},
      });
      if (d.classification.key === 'roof') roofMask = mask;
      if (d.classification.role === 'primary-wall' || d.classification.role === 'accent-wall') {
        wallMaskForColor = wallMaskForColor ? orMask(wallMaskForColor, mask, N) : mask;
      }
    }
  }

  const houseBbox = geom.maskBbox(unionMask, W, H);
  const bboxArea = houseBbox ? houseBbox.w * houseBbox.h : 0;
  const areaRatio = bboxArea / N;
  const present = !!houseBbox && areaRatio > 0.03 && surfaces.length > 0;

  if (!present) {
    return {
      scale: { width: W, height: H, factor: scale },
      house: { present: false, bbox: null, confidence: 0, style: 'unknown', material: 'unknown', color: null },
      surfaces: [],
      objects: [],
      context: { skyColor: null, groundColor: null, roofColor: null, wallColor: null, lighting: 1, palette: geom.dominantPalette(rgba, N) },
    };
  }

  const wallColor = wallMaskForColor ? geom.colorOfMask(rgba, wallMaskForColor) : geom.colorOfMask(rgba, unionMask);
  const roofColor = roofMask ? geom.colorOfMask(rgba, roofMask) : null;
  const roofRowFrac = roofMask ? geom.countOn(roofMask) / geom.countOn(unionMask) : 0;
  const wallL = wallColor ? require('../color').rgbToHsl(wallColor.r, wallColor.g, wallColor.b).l * 100 : 50;

  const house = {
    present: true,
    bbox: houseBbox,
    confidence: Math.min(0.95, Math.max(0.3, 0.45 + areaRatio * 1.4)),
    style: geom.guessStyle(houseBbox.w, houseBbox.h, roofRowFrac),
    material: geom.guessMaterial(wallColor),
    color: wallColor,
  };
  const context = {
    skyColor: null,
    groundColor: null,
    roofColor,
    wallColor,
    lighting: Math.min(1.3, Math.max(0.7, wallL / 55)),
    palette: geom.dominantPalette(rgba, N),
  };

  return { scale: { width: W, height: H, factor: scale }, house, surfaces, objects, context };
}

// Gemini can return multiple instances of the same class (e.g. two
// "pillar" detections) — suffix repeats so class_key stays unique per
// analysis the way houseSceneNormalizer.js's fixed single-instance keys
// implicitly were.
function dedupeKey(key) {
  const n = (surfaceKeyCounts.get(key) || 0) + 1;
  surfaceKeyCounts.set(key, n);
  return n === 1 ? key : `${key}-${n}`;
}

function orMask(a, b, N) { const out = new Uint8Array(N); for (let i = 0; i < N; i++) out[i] = (a[i] || b[i]) ? 1 : 0; return out; }
function round3(v) { return Math.round(v * 1000) / 1000; }

module.exports = {
  id: ID,
  version: VERSION,
  supports,
  run,
  // exported for pure-logic unit tests (no network)
  classifyLabel,
};
