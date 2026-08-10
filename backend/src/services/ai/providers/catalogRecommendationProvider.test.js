const test = require('node:test');
const assert = require('node:assert/strict');
const provider = require('./catalogRecommendationProvider');

const PAINTS = [
  { id: 1, r_value: 200, g_value: 200, b_value: 195 },
  { id: 2, r_value: 255, g_value: 255, b_value: 255 },
  { id: 3, r_value: 40, g_value: 40, b_value: 40 },
  { id: 4, r_value: 30, g_value: 90, b_value: 160 },
  { id: 5, r_value: 120, g_value: 70, b_value: 40 },
];

const SURFACES = [
  { className: 'front-wall', paintable: true },
  { className: 'trim', paintable: true },
  { className: 'door', paintable: true },
  { className: 'roof', paintable: true },
];

function analysisFor(material, style) {
  return {
    house: { color: { r: 190, g: 185, b: 175 }, material, style },
    context: { wallColor: { r: 190, g: 185, b: 175 }, roofColor: { r: 60, g: 55, b: 50 }, lighting: 1 },
    surfaces: SURFACES,
  };
}

test('every scheme is catalog-only — every paintId resolves to a real supplied paint', async () => {
  const result = await provider.run('paint-recommendation', {
    analysis: analysisFor('unknown', 'unknown'),
    paints: PAINTS,
    count: 8,
  });
  const ids = new Set(PAINTS.map((p) => p.id));
  for (const scheme of result.output.schemes) {
    for (const s of scheme.surfaces) assert.ok(ids.has(s.paintId), `${scheme.name} used a non-catalog paintId ${s.paintId}`);
  }
});

test('schemes are ranked (scores are non-increasing) and requesting fewer schemes returns the top-scored, not the first N by template order', async () => {
  const full = await provider.run('paint-recommendation', { analysis: analysisFor('unknown', 'unknown'), paints: PAINTS, count: 8 });
  const scores = full.output.schemes.map((s) => s.score);
  for (let i = 1; i < scores.length; i++) assert.ok(scores[i] <= scores[i - 1], 'schemes must be returned in descending score order');

  const top3 = await provider.run('paint-recommendation', { analysis: analysisFor('unknown', 'unknown'), paints: PAINTS, count: 3 });
  assert.deepEqual(top3.output.schemes.map((s) => s.id), full.output.schemes.slice(0, 3).map((s) => s.id));
});

test('house material/style context measurably shifts ranking', async () => {
  const brick = await provider.run('paint-recommendation', { analysis: analysisFor('brick', 'traditional'), paints: PAINTS, count: 8 });
  const modern = await provider.run('paint-recommendation', { analysis: analysisFor('render', 'modern'), paints: PAINTS, count: 8 });

  const rank = (result, id) => result.output.schemes.findIndex((s) => s.id === id);
  // Heritage Elegance is affine to brick/traditional and should rank higher
  // there than for a render/modern house.
  assert.ok(rank(brick, 'heritage') < rank(modern, 'heritage'), 'heritage should rank better for a brick/traditional house');
  // Modern Monochrome is affine to render/modern and should rank higher there.
  assert.ok(rank(modern, 'modern-monochrome') < rank(brick, 'modern-monochrome'), 'modern-monochrome should rank better for a render/modern house');
});

test('empty catalog throws rather than inventing colors', async () => {
  await assert.rejects(
    () => provider.run('paint-recommendation', { analysis: analysisFor('unknown', 'unknown'), paints: [], count: 6 }),
    /catalog is empty/
  );
});
