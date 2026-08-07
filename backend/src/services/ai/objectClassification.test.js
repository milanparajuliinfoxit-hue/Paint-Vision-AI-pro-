const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyObject, REMOVABLE_CLASSES } = require('./objectClassification');

test('removable classes (tree/car/person/fence) classify as unrelated-object', () => {
  for (const cls of ['tree', 'car', 'person', 'fence']) {
    assert.equal(classifyObject(cls), 'unrelated-object', cls);
    assert.ok(REMOVABLE_CLASSES.has(cls));
  }
});

test('window classifies as a non-paintable house component, not removable', () => {
  assert.equal(classifyObject('window'), 'non-paintable-house-component');
  assert.ok(!REMOVABLE_CLASSES.has('window'));
});

test('an unrecognized class defaults to house-component (never silently removable)', () => {
  assert.equal(classifyObject('some-future-class'), 'non-paintable-house-component');
});
