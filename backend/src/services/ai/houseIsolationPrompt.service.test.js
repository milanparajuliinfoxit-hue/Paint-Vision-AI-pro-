const test = require('node:test');
const assert = require('node:assert/strict');
const { buildIsolationPrompt, buildObjectRemovalPrompt, PRESERVE_LIST, REMOVE_LIST } = require('./houseIsolationPrompt.service');

test('buildIsolationPrompt is a fixed, deterministic prompt (no arguments, no dealer text)', () => {
  assert.equal(buildIsolationPrompt.length, 0);
  assert.equal(buildIsolationPrompt(), buildIsolationPrompt());
});

test('buildIsolationPrompt explicitly protects the house\'s own compound wall/gate/pillars/balconies/railings', () => {
  const prompt = buildIsolationPrompt();
  for (const term of ['compound', 'wall belonging to the house', 'gate belonging to the house', 'pillars', 'balconies', 'railings']) {
    assert.ok(prompt.toLowerCase().includes(term.toLowerCase()), `expected prompt to mention "${term}"`);
  }
});

test('buildIsolationPrompt lists environmental clutter for removal (people, vehicles, construction, neighbors)', () => {
  const prompt = buildIsolationPrompt();
  for (const term of ['people', 'vehicles', 'construction', 'neighboring buildings', 'trees', 'scaffolding']) {
    assert.ok(prompt.toLowerCase().includes(term.toLowerCase()), `expected prompt to mention "${term}"`);
  }
});

test('buildIsolationPrompt tells the model to preserve architecture over aggressive cleanup on conflict', () => {
  const prompt = buildIsolationPrompt();
  assert.match(prompt, /more important than aggressive cleanup/);
});

test('PRESERVE_LIST and REMOVE_LIST do not silently share the exact same entries (structurally distinct concerns)', () => {
  const preserveSet = new Set(PRESERVE_LIST.map((s) => s.toLowerCase()));
  const overlap = REMOVE_LIST.filter((s) => preserveSet.has(s.toLowerCase()));
  assert.deepEqual(overlap, []);
});

test('buildObjectRemovalPrompt requires a non-empty instruction rather than building an empty-target prompt', () => {
  assert.throws(() => buildObjectRemovalPrompt(''), /non-empty removal instruction/);
  assert.throws(() => buildObjectRemovalPrompt(null), /non-empty removal instruction/);
  assert.throws(() => buildObjectRemovalPrompt(undefined), /non-empty removal instruction/);
});

test('buildObjectRemovalPrompt embeds the exact dealer text as the removal target, quoted', () => {
  const prompt = buildObjectRemovalPrompt('remove the ladder and the people');
  assert.match(prompt, /"remove the ladder and the people"/);
});

test('buildObjectRemovalPrompt still carries the same architecture-preservation rules as buildIsolationPrompt', () => {
  const prompt = buildObjectRemovalPrompt('remove the car');
  for (const term of ['compound', 'gate belonging to the house', 'pillars', 'balconies', 'railings']) {
    assert.ok(prompt.toLowerCase().includes(term.toLowerCase()), `expected prompt to mention "${term}"`);
  }
  assert.match(prompt, /preserving the house correctly is more important/);
});

test('buildObjectRemovalPrompt never removes anything not named by the dealer', () => {
  const prompt = buildObjectRemovalPrompt('remove the bicycle');
  assert.match(prompt, /REMOVE ONLY the following/);
  assert.match(prompt, /Do not remove or alter anything else/);
});
