const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRecolorPrompt } = require('./visualizationPrompt.service');

test('buildRecolorPrompt embeds every surface\'s catalog name + hex, never a bare paint id', () => {
  const prompt = buildRecolorPrompt([
    { displayName: 'Front wall', paint: { colorName: 'Forest Whisper', hexValue: '#2B5D3F' } },
    { displayName: 'Trim', paint: { colorName: 'Cloud White', hexValue: '#F2F0EA' } },
  ]);
  assert.match(prompt, /Front wall: change to "Forest Whisper" \(#2B5D3F\)/);
  assert.match(prompt, /Trim: change to "Cloud White" \(#F2F0EA\)/);
});

test('buildRecolorPrompt always appends the structural-preservation clause', () => {
  const prompt = buildRecolorPrompt([{ displayName: 'Wall', paint: { colorName: 'X', hexValue: '#000000' } }]);
  assert.match(prompt, /Keep everything else in the image exactly the same/);
  assert.match(prompt, /Do not add, remove, resize, or move any architectural element/);
});

test('buildRecolorPrompt rejects an empty plan rather than silently building a prompt with no instructions', () => {
  assert.throws(() => buildRecolorPrompt([]), /at least one resolved surface/);
  assert.throws(() => buildRecolorPrompt(null), /at least one resolved surface/);
});

test('buildRecolorPrompt appends userIntent as non-overriding advisory guidance, after the catalog colors', () => {
  const plan = [{ displayName: 'Wall', paint: { colorName: 'X', hexValue: '#000000' } }];
  const prompt = buildRecolorPrompt(plan, { userIntent: 'make it feel warm and inviting' });
  assert.match(prompt, /advisory tone\/mood/);
  assert.match(prompt, /"make it feel warm and inviting"/);
  assert.match(prompt, /never change any of the.*colors specified above/);
  const colorIndex = prompt.indexOf('Wall: change to');
  const intentIndex = prompt.indexOf('make it feel warm');
  assert.ok(colorIndex >= 0 && intentIndex > colorIndex, 'intent text must appear after the color instructions');
});

test('buildRecolorPrompt omits the intent block entirely when no intent is given', () => {
  const plan = [{ displayName: 'Wall', paint: { colorName: 'X', hexValue: '#000000' } }];
  const withoutIntent = buildRecolorPrompt(plan);
  const withEmptyIntent = buildRecolorPrompt(plan, { userIntent: '   ' });
  assert.doesNotMatch(withoutIntent, /advisory tone\/mood/);
  assert.doesNotMatch(withEmptyIntent, /advisory tone\/mood/);
});

test('buildRecolorPrompt defensively clamps an over-long intent to 500 characters', () => {
  const plan = [{ displayName: 'Wall', paint: { colorName: 'X', hexValue: '#000000' } }];
  const prompt = buildRecolorPrompt(plan, { userIntent: 'x'.repeat(1000) });
  const match = prompt.match(/"(x+)"/);
  assert.ok(match, 'expected the quoted intent text to appear in the prompt');
  assert.equal(match[1].length, 500);
});
