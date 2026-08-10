import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useVisualizerStore } from './visualizerStore.js';

// Regression coverage for the "undo works until reload, then old state
// comes back" bug: history_entries is an append-only log that never
// records an undo/redo, so hydrating with "pointer = end of log" (the old
// default) silently assumes nothing was ever undone. hydrateHistory now
// takes the project's persisted pointer explicitly.

test('hydrateHistory uses the persisted pointer when given one, not the log length', () => {
  const entries = [{ type: 'create', layerId: 1 }, { type: 'create', layerId: 2 }, { type: 'create', layerId: 3 }];
  useVisualizerStore.getState().hydrateHistory(entries, 0);
  assert.equal(useVisualizerStore.getState().undoPointer, 0);
  assert.equal(useVisualizerStore.getState().undoStack.length, 3);
});

test('hydrateHistory falls back to log length - 1 when no pointer is given (back-compat)', () => {
  const entries = [{ type: 'create', layerId: 1 }, { type: 'create', layerId: 2 }];
  useVisualizerStore.getState().hydrateHistory(entries);
  assert.equal(useVisualizerStore.getState().undoPointer, 1);
});

test('hydrateHistory clamps a persisted pointer that is beyond the current log (defensive, e.g. a shrunk log)', () => {
  const entries = [{ type: 'create', layerId: 1 }];
  useVisualizerStore.getState().hydrateHistory(entries, 99);
  assert.equal(useVisualizerStore.getState().undoPointer, 0);
});

test('hydrateHistory with an empty log and pointer -1 leaves nothing applied', () => {
  useVisualizerStore.getState().hydrateHistory([], -1);
  assert.equal(useVisualizerStore.getState().undoPointer, -1);
  assert.equal(useVisualizerStore.getState().undoStack.length, 0);
});
