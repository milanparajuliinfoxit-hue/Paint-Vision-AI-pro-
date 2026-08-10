import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRecolorActiveLayer, isColorMismatch } from './colorOwnership.js';

// Regression coverage for "PROMPT — FIX PAINT COLOR PERSISTENCE / LAYER
// COLOR IMMUTABILITY": selecting a new color must affect only the next
// paint operation, never retroactively repaint an already-painted layer.

// 1. Paint area A, then pick a new color without touching the Layers panel
// (the reported repro) — the layer that was just painted must not recolor.
test('canRecolorActiveLayer: false for a layer that is only active as an implicit paint-continuation target', () => {
  const layer = { id: 1, current_color_id: 10 };
  assert.equal(canRecolorActiveLayer(layer, false), false);
});

// 2. Deliberately clicking a layer in the Layers/Finishes panel, then
// picking a color, is the documented "select a layer, apply a color to it"
// feature (CatalogTab's hint text) — must keep working.
test('canRecolorActiveLayer: true for a layer the dealer explicitly selected', () => {
  const layer = { id: 1, current_color_id: 10 };
  assert.equal(canRecolorActiveLayer(layer, true), true);
});

// 3. No active layer at all (nothing painted yet, nothing selected) — a
// color pick is purely "set the pending color," nothing to recolor.
test('canRecolorActiveLayer: false when there is no active layer', () => {
  assert.equal(canRecolorActiveLayer(null, true), false);
  assert.equal(canRecolorActiveLayer(undefined, true), false);
});

// 4. Continuing to paint the *same* color on the same layer (mask-edit
// "add to mask") must keep merging into it — this is not a new operation.
test('isColorMismatch: false when the pending color matches the active layer\'s own color', () => {
  const activeLayer = { current_color_id: 10 };
  assert.equal(isColorMismatch({ activeLayer, pendingColorId: 10, subtract: false }), false);
});

// 5. Painting with a *different* pending color than the active layer's
// stored color must start a new paint operation instead of silently
// repainting the layer's existing region (the mask-edit half of the bug).
test('isColorMismatch: true when the pending color differs from the active layer\'s own color', () => {
  const activeLayer = { current_color_id: 10 };
  assert.equal(isColorMismatch({ activeLayer, pendingColorId: 20, subtract: false }), true);
});

// 6. Subtracting (erasing mask via Alt/"Remove from mask") never introduces
// color, so a color mismatch must never block it.
test('isColorMismatch: false for a subtract stroke even when colors differ', () => {
  const activeLayer = { current_color_id: 10 };
  assert.equal(isColorMismatch({ activeLayer, pendingColorId: 20, subtract: true }), false);
});

// 7. A brand-new layer with no color yet (currentColorId undefined) has
// nothing to mismatch against — first paint on it always merges.
test('isColorMismatch: false when the active layer has no color of its own yet', () => {
  const activeLayer = { current_color_id: null };
  assert.equal(isColorMismatch({ activeLayer, pendingColorId: 20, subtract: false }), false);
});

// 8. No pending color selected (e.g. straight after an eyedropper reset) —
// nothing to compare, so no forced new-layer split.
test('isColorMismatch: false when there is no pending color to compare', () => {
  const activeLayer = { current_color_id: 10 };
  assert.equal(isColorMismatch({ activeLayer, pendingColorId: null, subtract: false }), false);
});
