import { useEffect, useRef } from 'react';
import { useUpdateLayer, useDeleteLayer, useRestoreLayer } from './useLayers';
import { useAppendHistory, useHistoryList } from './useHistoryEntries';
import { useVisualizerStore } from '../store/visualizerStore';
import { reportError } from '../../../shared/lib/errorReporter';

// Command pattern (requirements doc, Section 5.3): each entry stores enough
// to invert the action rather than a full-state snapshot. Undo/redo is
// local + instant; every commit is also mirrored to /projects/:id/history
// so the stack survives a refresh.
//
// A command's `type` says what kind of action it is and therefore how to
// invert it — this is the piece the previous implementation was missing.
// Only 'patch' (change a field on a layer that already exists) was ever
// pushed onto the undo stack; creating or deleting a layer was either
// logged read-only or not logged at all, which is why undo could only ever
// touch a layer that already existed. Every mutation that changes what's
// on screen now goes through here:
//   - 'patch'       — field(s) on an existing layer changed (color, opacity,
//                      mask pixels, visibility, lock, order).
//   - 'create'      — a new layer was painted. Undo = soft-delete it.
//   - 'delete'      — a layer was removed. Undo = restore it (same id, same
//                      mask file — nothing was ever hard-deleted).
//   - 'bulk-delete' — many layers removed at once (e.g. "Clear all paint").
//                      Undo = restore all of them as one step.
const ACTION_TYPE = {
  'color-applied': 'patch',
  'opacity-changed': 'patch',
  'visibility-changed': 'patch',
  'lock-changed': 'patch',
  'order-changed': 'patch',
  'mask-edited': 'patch',
  'name-changed': 'patch',
  'finish-changed': 'patch',
  'mask-created': 'create',
  'layer-deleted': 'delete',
  'paint-cleared': 'bulk-delete',
};

export function useHistoryCommand(projectId, assetId) {
  const updateLayer = useUpdateLayer(assetId);
  const removeLayer = useDeleteLayer(assetId);
  const restoreLayer = useRestoreLayer(assetId);
  const appendHistory = useAppendHistory(projectId);
  const { data: historyEntries } = useHistoryList(projectId);

  const pushCommand = useVisualizerStore((s) => s.pushCommand);
  const hydrateHistory = useVisualizerStore((s) => s.hydrateHistory);
  const undoStack = useVisualizerStore((s) => s.undoStack);
  const undoPointer = useVisualizerStore((s) => s.undoPointer);
  const moveUndoPointer = useVisualizerStore((s) => s.moveUndoPointer);
  const activeLayerId = useVisualizerStore((s) => s.activeLayerId);
  const setActiveLayerId = useVisualizerStore((s) => s.setActiveLayerId);

  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current || !historyEntries) return;
    hydrated.current = true;
    hydrateHistory(
      historyEntries
        .filter((e) => ACTION_TYPE[e.action]) // unrecognized/legacy log-only entries don't participate in undo
        .map((e) => {
          const type = ACTION_TYPE[e.action];
          if (type === 'bulk-delete') {
            const layerIds = e.before_state?.layerIds || e.after_state?.layerIds || [];
            return { type, action: e.action, layerIds };
          }
          const layerId = e.after_state?.layerId ?? e.before_state?.layerId;
          return {
            type,
            action: e.action,
            layerId,
            before: type === 'patch' ? stripLayerId(e.before_state) : null,
            after: type === 'patch' ? stripLayerId(e.after_state) : null,
          };
        })
    );
  }, [historyEntries, hydrateHistory]);

  // Records a patch-type command in both the persisted history log and the
  // local undo stack, without performing any mutation itself — `commit`
  // and `commitMaskEdit` each apply the mutation their own way first, then
  // both funnel through here so undo/redo/jumpTo see one consistent shape.
  function recordPatch({ action, layerId, before, after }) {
    appendHistory.mutate({
      action,
      beforeState: { layerId, ...before },
      afterState: { layerId, ...after },
    });
    pushCommand({ type: 'patch', action, layerId, before, after });
  }

  // Plain field patch on a layer that already exists (color, opacity,
  // visibility, lock, order, or a re-pointed mask path).
  function commit({ action, layerId, before, after }) {
    updateLayer.mutate({ layerId, patch: after });
    recordPatch({ action, layerId, before, after });
  }

  // A brush stroke re-uploads the mask as a brand-new file (storage never
  // overwrites), so the *old* mask_path is still a valid file on disk —
  // undoing a mask edit is just pointing mask_path back at it, no re-upload
  // needed. Used by both the brush's mask-edit mode and the eraser.
  async function commitMaskEdit({ action, layerId, maskBlob, beforeMaskPath }) {
    const updated = await updateLayer.mutateAsync({ layerId, patch: {}, maskBlob });
    recordPatch({ action, layerId, before: { maskPath: beforeMaskPath || null }, after: { maskPath: updated.mask_path } });
  }

  // A tool just produced a brand-new layer (rect/lasso/polygon/magic-wand/
  // brush-new-surface). The layer already exists server-side by the time
  // this is called — this only makes that creation undoable.
  function commitCreate({ layerId, createdVia }) {
    appendHistory.mutate({ action: 'mask-created', beforeState: null, afterState: { layerId, createdVia } });
    pushCommand({ type: 'create', action: 'mask-created', layerId });
  }

  // Single-layer delete (the ✕ button in the Layers panel).
  function commitDelete(layer) {
    removeLayer.mutate(layer.id);
    if (activeLayerId === layer.id) setActiveLayerId(null);
    appendHistory.mutate({ action: 'layer-deleted', beforeState: { layerId: layer.id }, afterState: null });
    pushCommand({ type: 'delete', action: 'layer-deleted', layerId: layer.id });
  }

  // "Clear all paint" — removes every layer on the current asset as one
  // undoable step instead of forcing the user to delete rows one at a time.
  function commitBulkClear(layerIds) {
    if (layerIds.length === 0) return;
    layerIds.forEach((id) => removeLayer.mutate(id));
    if (layerIds.includes(activeLayerId)) setActiveLayerId(null);
    appendHistory.mutate({ action: 'paint-cleared', beforeState: { layerIds }, afterState: null });
    pushCommand({ type: 'bulk-delete', action: 'paint-cleared', layerIds });
  }

  // Undo lands on a command's "before" state; redo lands on its "after"
  // state — the same replay, just in the opposite direction, dispatched by
  // command type rather than assumed to always be a field patch.
  // Awaits the server write rather than firing it and assuming success: the
  // undo pointer must only move once the mutation it describes has actually
  // landed, otherwise a rejected request left the pointer (and the History
  // tab) claiming a state the server never reached, with nothing on screen.
  function applyCommand(command, target) {
    switch (command.type) {
      case 'patch':
        return updateLayer.mutateAsync({ layerId: command.layerId, patch: command[target] });
      case 'create':
        return target === 'before' ? removeLayer.mutateAsync(command.layerId) : restoreLayer.mutateAsync(command.layerId);
      case 'delete':
        return target === 'before' ? restoreLayer.mutateAsync(command.layerId) : removeLayer.mutateAsync(command.layerId);
      case 'bulk-delete':
        return Promise.all(
          command.layerIds.map((id) =>
            target === 'before' ? restoreLayer.mutateAsync(id) : removeLayer.mutateAsync(id)
          )
        );
      default:
        return Promise.resolve(null);
    }
  }

  async function undo() {
    if (undoPointer < 0) return;
    try {
      await applyCommand(undoStack[undoPointer], 'before');
      moveUndoPointer(-1);
    } catch (err) {
      reportError(err, { action: 'Undo' });
    }
  }

  async function redo() {
    if (undoPointer >= undoStack.length - 1) return;
    try {
      await applyCommand(undoStack[undoPointer + 1], 'after');
      moveUndoPointer(1);
    } catch (err) {
      reportError(err, { action: 'Redo' });
    }
  }

  // Scrubbing the History tab: replay every command between the current
  // pointer and the clicked entry, in order, landing exactly on that point.
  // A step that fails stops the replay and leaves the pointer on the last
  // step that did apply, so the History tab keeps matching the server.
  async function jumpTo(targetIndex) {
    if (targetIndex === undoPointer) return;
    let reached = undoPointer;
    try {
      if (targetIndex > undoPointer) {
        for (let i = undoPointer + 1; i <= targetIndex; i++) {
          await applyCommand(undoStack[i], 'after');
          reached = i;
        }
      } else {
        for (let i = undoPointer; i > targetIndex; i--) {
          await applyCommand(undoStack[i], 'before');
          reached = i - 1;
        }
      }
    } catch (err) {
      reportError(err, { action: 'Jumping to history entry' });
    } finally {
      useVisualizerStore.setState({ undoPointer: reached });
    }
  }

  return {
    commit,
    commitMaskEdit,
    commitCreate,
    commitDelete,
    commitBulkClear,
    undo,
    redo,
    jumpTo,
    undoPointer,
    undoStack,
    canUndo: undoPointer >= 0,
    canRedo: undoPointer < undoStack.length - 1,
  };
}

function stripLayerId(state) {
  if (!state) return {}; // legacy entries may omit before/after state
  const { layerId, ...rest } = state;
  return rest;
}
