/**
 * Hosted-LLM paint-recommendation provider ("hf-scheme").
 *
 * Real external AI call (HF Inference Providers -> an OpenAI-compatible
 * chat/completions endpoint, verified live against meta-llama/Llama-3.1-8B-Instruct
 * via the `novita` provider) drives the *creative/contextual* half of scheme
 * generation — reading the house's real detected style/material/context and
 * proposing a cohesive palette concept per scheme. It does NOT pick catalog
 * paint ids itself: LLMs are unreliable at recalling an exact id out of a
 * catalog that can run to thousands of rows, and sending the whole catalog
 * on every call would be slow and expensive. Instead the model outputs an
 * HSL *target* per role, and the same deterministic nearest-catalog-match
 * math the `catalog` provider already uses (color.js + the `pick` logic
 * here, mirroring catalogRecommendationProvider.js's `pick`) resolves each
 * target to a real paint. That makes "every color is a real catalog id"
 * true by construction, not just by a post-hoc rejection check — though the
 * explicit check still runs too, as a defense-in-depth backstop.
 *
 * Env:
 *   HF_API_KEY                  - required (already used by cleanup).
 *   AI_SCHEME_MODEL              - default meta-llama/Llama-3.1-8B-Instruct
 *   AI_SCHEME_MODEL_PROVIDER     - default novita (HF-router backend serving it —
 *                                  verified live this session; see inferenceProviderMapping)
 *   AI_VISION_TIMEOUT_MS         - reused for the request timeout (default 60000)
 */
const { rgbToLab, labDistance, hslToRgb, clamp } = require('../color');
const { post, ProviderError } = require('../../providers/httpClient');
const catalogProvider = require('./catalogRecommendationProvider');

const ID = 'hf-scheme';
const VERSION = 'hf-llama-3.1-8b-instruct-v1';
const ROUTER_URL = 'https://router.huggingface.co/v1/chat/completions';

function supports(capability) {
  return capability === 'paint-recommendation';
}

async function run(capability, input) {
  if (!supports(capability)) {
    throw new Error(`hf-scheme provider does not support capability "${capability}"`);
  }
  const { analysis, paints, count } = input;
  if (!paints || !paints.length) throw new Error('The paint catalog is empty — cannot generate recommendations.');

  const pool = catalogProvider.filterPool(paints, input.productLines);
  const schemeCount = Math.max(1, Math.min(10, Number(count) || 6));

  const roles = eligibleRoles(analysis);
  if (!roles.length) throw new Error('No paintable surfaces with a known role — cannot generate schemes.');

  const raw = await callModel({ analysis, roles, schemeCount });
  const schemes = raw
    .map((s) => resolveScheme(s, roles, pool))
    .filter(Boolean)
    .slice(0, schemeCount);

  if (!schemes.length) {
    throw new ProviderError('The model did not return any usable schemes (all failed validation).', { provider: ID });
  }

  return { output: { schemes }, confidence: 1, modelVersion: process.env.AI_SCHEME_MODEL || VERSION };
}

// Which roles this house's own detected surfaces actually support — the
// model is only ever asked to fill slots that exist on this photo.
function eligibleRoles(analysis) {
  const present = new Set();
  const classForRole = {};
  for (const s of analysis.surfaces || []) {
    if (!s.paintable) continue;
    const role = catalogProvider.ROLE_BY_CLASS[s.className] || s.role || null;
    if (role && !present.has(role)) {
      present.add(role);
      classForRole[role] = s.className;
    }
  }
  return catalogProvider.ROLE_ORDER.filter((r) => present.has(r)).map((role) => ({ role, surfaceClass: classForRole[role] }));
}

async function callModel({ analysis, roles, schemeCount }) {
  const apiKey = (process.env.HF_API_KEY || '').trim();
  if (!apiKey) {
    throw new ProviderError('HF_API_KEY is missing — the hf-scheme provider needs it (see .env.example)', { provider: ID });
  }
  const model = process.env.AI_SCHEME_MODEL || 'meta-llama/Llama-3.1-8B-Instruct';
  const modelProvider = process.env.AI_SCHEME_MODEL_PROVIDER || 'novita';
  const timeoutMs = Number(process.env.AI_VISION_TIMEOUT_MS) || 60000;

  const prompt = buildPrompt({ analysis, roles, schemeCount });
  const body = JSON.stringify({
    model: `${model}:${modelProvider}`,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1200,
    temperature: 0.7,
  });

  const response = await post({
    url: ROUTER_URL,
    provider: ID,
    model,
    timeoutMs,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body,
  });

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new ProviderError('Model response had no content.', { provider: ID, model });
  }
  return parseSchemes(content);
}

// The prompt asks for HSL *targets*, never catalog ids — the model has no
// visibility into the catalog at all, so it cannot invent or misremember an
// id. House context is the real detected data (house.style/material/color,
// context.wallColor/roofColor/skyColor/lighting), not a guess.
function buildPrompt({ analysis, roles, schemeCount }) {
  const house = analysis.house || {};
  const ctx = analysis.context || {};
  const roleList = roles.map((r) => r.role).join(', ');
  const describeColor = (c) => (c ? `rgb(${c.r},${c.g},${c.b})` : 'unknown');

  return `You are a professional exterior house-paint color consultant. Propose ${schemeCount} distinct, cohesive paint color schemes for the house described below. Respond with ONLY a JSON array (no markdown fences, no commentary) of exactly ${schemeCount} objects, each shaped exactly like:
{"name": "short scheme name", "tagline": "one short sentence", "roles": {${roles.map((r) => `"${r.role}": {"h": <0-360>, "s": <0-1>, "l": <0-1>}`).join(', ')}}}

House context (real, detected from the photo):
- style: ${house.style || 'unknown'}
- material: ${house.material || 'unknown'}
- current wall color: ${describeColor(ctx.wallColor || house.color)}
- current roof color: ${describeColor(ctx.roofColor)}
- sky color: ${describeColor(ctx.skyColor)}
- lighting: ${ctx.lighting ?? 'unknown'}

Roles to fill in every scheme (h/s/l are your intended target color for that surface, on a real house — not a specific product): ${roleList}.

Make the ${schemeCount} schemes genuinely different from each other in character (e.g. neutral vs. bold vs. warm vs. cool), each internally cohesive, and each with real lightness contrast between the wall and its trim/doors. Respond with the JSON array only.`;
}

function parseSchemes(content) {
  // Chat models routinely wrap JSON in ```json fences despite instructions
  // not to — strip them rather than fail on a cosmetic wrapper.
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new ProviderError(`Model did not return valid JSON: ${err.message}`, { provider: ID });
  }
  if (!Array.isArray(parsed)) {
    throw new ProviderError('Model response was valid JSON but not an array of schemes.', { provider: ID });
  }
  return parsed;
}

// Resolves one model-proposed scheme (symbolic HSL targets) into a real
// scheme (real catalog paint ids). Any role that fails validation is
// dropped rather than filled with a guess; a scheme with zero valid roles
// is dropped entirely by the caller's .filter(Boolean).
function resolveScheme(proposed, roles, pool) {
  if (!proposed || typeof proposed !== 'object' || !proposed.roles || typeof proposed.roles !== 'object') return null;

  const used = new Set();
  const surfaces = [];
  for (const { role, surfaceClass } of roles) {
    const target = proposed.roles[role];
    if (!isValidHsl(target)) continue;
    const rgb = hslToRgb(clamp(target.h, 0, 360), clamp(target.s, 0, 1), clamp(target.l, 0, 1));
    const targetLab = rgbToLab(rgb.r, rgb.g, rgb.b);
    const paint = pick(pool, targetLab, used);
    if (!paint) continue;
    // Defense-in-depth: `pick` can only ever return an item from `pool`
    // (itself derived from the real catalog passed in), so this can never
    // actually fail — but an AI-generated-scheme's paintId is exactly the
    // value this system's own governing rule says must never be invented,
    // so it gets an explicit, unconditional check rather than trusting the
    // resolution code silently.
    if (!pool.some((p) => p.id === paint.id)) continue;
    used.add(paint.id);
    surfaces.push({ role, surfaceClass, paintId: paint.id });
  }
  if (!surfaces.length) return null;

  return {
    id: `hf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: typeof proposed.name === 'string' && proposed.name.trim() ? proposed.name.trim() : 'AI Scheme',
    tagline: typeof proposed.tagline === 'string' ? proposed.tagline.trim() : '',
    surfaces,
  };
}

function isValidHsl(v) {
  return v && typeof v === 'object'
    && Number.isFinite(Number(v.h)) && Number.isFinite(Number(v.s)) && Number.isFinite(Number(v.l));
}

// Nearest real catalog paint to a LAB target, preferring an unused one so a
// scheme reads as a palette rather than one color repeated — identical
// selection rule to catalogRecommendationProvider.js's `pick`.
function pick(pool, targetLab, used) {
  let best = null, bestDist = Infinity;
  let alt = null, altDist = Infinity;
  for (const p of pool) {
    const d = labDistance(targetLab, rgbToLab(p.r_value, p.g_value, p.b_value));
    if (d < bestDist) { bestDist = d; best = p; }
    if (!used.has(p.id) && d < altDist) { altDist = d; alt = p; }
  }
  return alt || best;
}

module.exports = { id: ID, version: VERSION, supports, run, parseSchemes, resolveScheme, eligibleRoles };
