const test = require('node:test');
const assert = require('node:assert/strict');
const provider = require('./hfSchemeProvider');

// Pure-logic tests only — no network call, no HF_API_KEY needed. The real
// live model call is verified separately (manually, against the real HF
// endpoint) and is NOT re-run here; a unit test asserting against a canned
// fixture response is not "AI verification," it's a parser/resolver test.

const PAINTS = [
  { id: 1, r_value: 200, g_value: 200, b_value: 195 }, // light neutral
  { id: 2, r_value: 255, g_value: 255, b_value: 255 }, // white
  { id: 3, r_value: 40, g_value: 40, b_value: 40 }, // near-black
  { id: 4, r_value: 30, g_value: 90, b_value: 160 }, // blue
  { id: 5, r_value: 120, g_value: 70, b_value: 40 }, // brown
];

const ROLES = [
  { role: 'primary-wall', surfaceClass: 'front-wall' },
  { role: 'trim', surfaceClass: 'trim' },
];

test('eligibleRoles maps detected paintable surfaces to roles, in ROLE_ORDER, deduped', () => {
  const analysis = {
    surfaces: [
      { className: 'left-wall', paintable: true },
      { className: 'front-wall', paintable: true },
      { className: 'trim', paintable: true },
      { className: 'window', paintable: false }, // not in ROLE_BY_CLASS at all -> ignored
      { className: 'right-wall', paintable: true }, // same role as left-wall (accent-wall) -> deduped
    ],
  };
  const roles = provider.eligibleRoles(analysis);
  assert.deepEqual(roles.map((r) => r.role), ['primary-wall', 'accent-wall', 'trim']);
});

test('eligibleRoles returns nothing for an analysis with no paintable surfaces', () => {
  assert.deepEqual(provider.eligibleRoles({ surfaces: [{ className: 'window', paintable: false }] }), []);
});

test('parseSchemes accepts a plain JSON array', () => {
  const parsed = provider.parseSchemes('[{"name":"A"},{"name":"B"}]');
  assert.equal(parsed.length, 2);
});

test('parseSchemes strips a ```json fence the model added despite instructions not to', () => {
  const parsed = provider.parseSchemes('```json\n[{"name":"A"}]\n```');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, 'A');
});

test('parseSchemes rejects invalid JSON with a clear error, does not fabricate a result', () => {
  assert.throws(() => provider.parseSchemes('not json at all'), /valid JSON/);
});

test('parseSchemes rejects a JSON object that is not an array', () => {
  assert.throws(() => provider.parseSchemes('{"name":"A"}'), /array/);
});

test('resolveScheme resolves every role to a real supplied paint id, never an invented one', () => {
  const proposed = { name: 'Test', tagline: 'x', roles: { 'primary-wall': { h: 210, s: 0.5, l: 0.4 }, trim: { h: 0, s: 0, l: 0.95 } } };
  const scheme = provider.resolveScheme(proposed, ROLES, PAINTS);
  assert.ok(scheme);
  const ids = new Set(PAINTS.map((p) => p.id));
  for (const s of scheme.surfaces) assert.ok(ids.has(s.paintId));
});

test('resolveScheme skips a role with a missing/malformed HSL target rather than guessing', () => {
  const proposed = { name: 'Test', roles: { 'primary-wall': { h: 210, s: 0.5, l: 0.4 }, trim: 'not-an-object' } };
  const scheme = provider.resolveScheme(proposed, ROLES, PAINTS);
  assert.equal(scheme.surfaces.length, 1);
  assert.equal(scheme.surfaces[0].role, 'primary-wall');
});

test('resolveScheme returns null for a scheme where every role fails validation (never a fake fallback scheme)', () => {
  const proposed = { name: 'Test', roles: { 'primary-wall': null, trim: undefined } };
  assert.equal(provider.resolveScheme(proposed, ROLES, PAINTS), null);
});

test('resolveScheme returns null for a malformed proposal shape', () => {
  assert.equal(provider.resolveScheme(null, ROLES, PAINTS), null);
  assert.equal(provider.resolveScheme({ name: 'no roles key' }, ROLES, PAINTS), null);
});

test('resolveScheme clamps out-of-range HSL rather than producing an undefined color', () => {
  const proposed = { name: 'Test', roles: { 'primary-wall': { h: 9999, s: 5, l: -3 } } };
  const scheme = provider.resolveScheme(proposed, [ROLES[0]], PAINTS);
  assert.ok(scheme);
  assert.ok(PAINTS.some((p) => p.id === scheme.surfaces[0].paintId));
});
