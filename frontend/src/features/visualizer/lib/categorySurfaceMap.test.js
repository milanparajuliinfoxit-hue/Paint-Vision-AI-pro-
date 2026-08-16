import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchSurfacesForCategory } from './categorySurfaceMap.js';

const SURFACES = [
  { class_key: 'front-wall', paintable: true, properties: { role: 'primary-wall' } },
  { class_key: 'left-wall', paintable: true, properties: {} },
  { class_key: 'window-frame', paintable: true, properties: {} },
  { class_key: 'window-frame-2', paintable: true, properties: {} },
  { class_key: 'door', paintable: true, properties: {} },
  { class_key: 'garage-door', paintable: true, properties: {} },
  { class_key: 'gate', paintable: true, properties: {} },
  { class_key: 'compound-wall', paintable: true, properties: {} },
  { class_key: 'pillar-1', paintable: true, properties: {} },
  { class_key: 'tree', paintable: false, properties: {} },
];

test('matchSurfacesForCategory: primary-wall matches by role, not just class_key text', () => {
  const matches = matchSurfacesForCategory('primary-wall', SURFACES);
  assert.deepEqual(matches.map((s) => s.class_key), ['front-wall']);
});

test('matchSurfacesForCategory: window matches every numbered instance', () => {
  const matches = matchSurfacesForCategory('window', SURFACES);
  assert.deepEqual(matches.map((s) => s.class_key).sort(), ['window-frame', 'window-frame-2']);
});

test('matchSurfacesForCategory: doors excludes garage-door (distinct category)', () => {
  const matches = matchSurfacesForCategory('doors', SURFACES);
  assert.deepEqual(matches.map((s) => s.class_key), ['door']);
});

test('matchSurfacesForCategory: garage-door matches only garage-door', () => {
  const matches = matchSurfacesForCategory('garage-door', SURFACES);
  assert.deepEqual(matches.map((s) => s.class_key), ['garage-door']);
});

test('matchSurfacesForCategory: gate excludes garage-door', () => {
  const matches = matchSurfacesForCategory('gate', SURFACES);
  assert.deepEqual(matches.map((s) => s.class_key), ['gate']);
});

test('matchSurfacesForCategory: column matches "pillar" naming', () => {
  const matches = matchSurfacesForCategory('column', SURFACES);
  assert.deepEqual(matches.map((s) => s.class_key), ['pillar-1']);
});

test('matchSurfacesForCategory: never returns a non-paintable surface (e.g. tree)', () => {
  const matches = matchSurfacesForCategory('roof', [{ class_key: 'roof', paintable: false, properties: {} }]);
  assert.deepEqual(matches, []);
});

test('matchSurfacesForCategory: gutter matches by role or class_key text', () => {
  const matches = matchSurfacesForCategory('gutter', [
    { class_key: 'gutter', paintable: true, properties: {} },
    { class_key: 'edge-strip', paintable: true, properties: { role: 'gutter' } },
    { class_key: 'roof', paintable: true, properties: {} },
  ]);
  assert.deepEqual(matches.map((s) => s.class_key).sort(), ['edge-strip', 'gutter']);
});

test('matchSurfacesForCategory: unknown category or missing surfaces returns empty, not a throw', () => {
  assert.deepEqual(matchSurfacesForCategory('not-a-real-category', SURFACES), []);
  assert.deepEqual(matchSurfacesForCategory('primary-wall', undefined), []);
  assert.deepEqual(matchSurfacesForCategory('primary-wall', null), []);
});
