const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyLabel } = require('./geminiVisionProvider');

test('classifyLabel maps documented architectural labels to paintable surfaces', () => {
  assert.equal(classifyLabel('compound wall').key, 'compound-wall');
  assert.equal(classifyLabel('compound wall').paintable, true);
  assert.equal(classifyLabel('railing').key, 'railing');
  assert.equal(classifyLabel('balcony wall').key, 'balcony-wall');
  assert.equal(classifyLabel('front door').key, 'door');
});

test('classifyLabel keeps windows/roof visible but non-paintable where the app already treats them that way', () => {
  assert.equal(classifyLabel('window').paintable, false);
  assert.equal(classifyLabel('window grill').key, 'window-frame');
});

test('classifyLabel checks more specific phrases before broader ones (compound wall before wall)', () => {
  assert.equal(classifyLabel('compound wall').key, 'compound-wall');
  assert.equal(classifyLabel('exterior wall').key, 'front-wall');
});

test('classifyLabel maps clutter classes to removable objects', () => {
  assert.equal(classifyLabel('tree').type, 'object');
  assert.equal(classifyLabel('parked car').type, 'object');
});

test('classifyLabel never drops an unrecognized label — Section 8 extensibility requirement', () => {
  const result = classifyLabel('ornamental cornice');
  assert.equal(result.type, 'surface');
  assert.equal(result.paintable, false);
  assert.equal(result.name, 'ornamental cornice');
});

test('classifyLabel returns null only for an empty/missing label', () => {
  assert.equal(classifyLabel(''), null);
  assert.equal(classifyLabel(undefined), null);
});
