import { useEffect, useRef } from 'react';
import { useUpdateLayer, useDeleteLayer, useRestoreLayer } from './useLayers';
import { useAppendHistory, useHistoryList } from './useHistoryEntries';
import { useProject, useSetUndoPointer } from '../../projects/useProjects';
import { useVisualizerStore } from '../store/visualizerStore';
import { debounce } from '../../../shared/lib/debounce';
import { logger } from '../../../shared/lib/logger';

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
  const { data: project } = useProject(projectId);
  const setUndoPointer = useSetUndoPointer(projectId);

  const pushCommand = useVisualizerStore((s) => s.pushCommand);
  const hydrateHistory = useVisualizerStore((s) => s.hydrateHistory);
  const undoStack = useVisualizerStore((s) => s.undoStack);
  const undoPointer = useVisualizerStore((s) => s.undoPointer);
  const moveUndoPointer = useVisualizerStore((s) => s.moveUndoPointer);
  const activeLayerId = useVisualizerStore((s) => s.activeLayerId);
  const setActiveLayerId = useVisualizerStore((s) => s.setActiveLayerId);

  // Seeds the stack from the persisted log AND the project's persisted
  // undo_pointer together — hydrating from the log alone (old behavior)
  // silently assumed nothing had ever been undone, which is why a delete
  // undone in a previous session came back as "current" after reload and
  // any further undo/redo replayed the wrong commands against already-
  // deleted layer ids (404s on PATCH/DELETE for stale ids).
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current || !historyEntries || !project) return;
    hydrated.current = true;
    hydrateHistory(
      historyEntries
        // unrecognized/legacy log-only entries don't participate in undo;
        // superseded ones are an abandoned redo branch (the user undid past
        // them, then made a different edit) — excluded so a reload can't
        // resurrect them via redo. Their rows/mask files are untouched on
        // disk/DB, just left out of the reconstructed stack. See
        // LAYER_MASK_HISTORY_AUDIT.md §G.1.
        .filter((e) => ACTION_TYPE[e.action] && !e.superseded_at)
        .map((e) => {
          const type = ACTION_TYPE[e.action];
          if (type === 'bulk-delete') {
            const layerIds = e.before_state?.layerIds || e.after_state?.layerIds || [];
            return { type, action: e.action, layerIds, historyEntryId: e.id };
          }
          const layerId = e.after_state?.layerId ?? e.before_state?.layerId;
          return {
            type,
            action: e.action,
            layerId,
            before: type === 'patch' ? stripLayerId(e.before_state) : null,
            after: type === 'patch' ? stripLayerId(e.after_state) : null,
            historyEntryId: e.id,
          };
        }),
      project.undo_pointer
    );
  }, [historyEntries, project, hydrateHistory]);

  // Mirrors every local pointer move back to the server (debounced — Ctrl+Z
  // mashing and History-tab scrubbing can move it several times a second,
  // and only the final position matters). Skips the move hydration itself
  // causes, since that value came *from* the server and writing it back is
  // a no-op at best and a lost race at worst if hydration for a second
  // asset switch lands after a real user move.
  const persistPointer = useRef(debounce((pointer) => setUndoPointer.mutate(pointer), 400)).current;
  useEffect(() => {
    if (!hydrated.current || !project || undoPointer === project.undo_pointer) return;
    persistPointer(undoPointer);
  }, [undoPointer, project, persistPointer]);

  // Every history-log append funnels through here so the abandoned-redo-tail
  // supersede marking (LAYER_MASK_HISTORY_AUDIT.md §G.1/I) happens exactly
  // once, in the same request that appends the new entry (history.model.js's
  // appendEntry does both in one transaction). `undoStack`/`undoPointer` are
  // read fresh from the closure — same assumption undo()/redo()/jumpTo()
  // already make. A failed append is logged, not thrown: local undo/redo
  // already works purely off updateLayer/removeLayer/restoreLayer calls, not
  // the history log itself, so a transient append failure shouldn't block
  // the local command from landing — only cross-reload replay of *this*
  // command would be affected, same fault tolerance this had before
  // (appendHistory was already fire-and-forget).
  async function appendAndPush(entryPayload, command) {
    const supersedeIds = undoStack
      .slice(undoPointer + 1)
      .map((c) => c.historyEntryId)
      .filter((id) => Number.isInteger(id));
    let historyEntryId = null;
    try {
      const entry = await appendHistory.mutateAsync({ ...entryPayload, supersedeIds });
      historyEntryId = entry.id;
    } catch (err) {
      logger.error('history.append.failed', { action: entryPayload.action, message: err?.message });
    }
    pushCommand({ ...command, historyEntryId });
  }

  // Records a patch-type command in both the persisted history log and the
  // local undo stack, without performing any mutation itself — `commit`
  // and `commitMaskEdit` each apply the mutation their own way first, then
  // both funnel through here so undo/redo/jumpTo see one consistent shape.
  function recordPatch({ action, layerId, before, after }) {
    return appendAndPush(
      { action, beforeState: { layerId, ...before }, afterState: { layerId, ...after } },
      { type: 'patch', action, layerId, before, after }
    );
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
  // needed. Used by both the brush's mask-edit mode and the eraser. Awaits
  // recordPatch (unlike `commit`) so that by the time this resolves, the
  // supersede-marking for this stroke's own abandoned tail (if any) has
  // definitely landed before the next stroke can compute *its* supersede set.
  async function commitMaskEdit({ action, layerId, maskBlob, beforeMaskPath }) {
    const updated = await updateLayer.mutateAsync({ layerId, patch: {}, maskBlob });
    await recordPatch({ action, layerId, before: { maskPath: beforeMaskPath || null }, after: { maskPath: updated.mask_path } });
  }

  // A tool just produced a brand-new layer (rect/lasso/polygon/magic-wand/
  // brush-new-surface, or an applied AI scheme/surface — useApplySurface.js
  // and useConcepts.js call this with createdVia:'ai-surface'). The layer
  // already exists server-side by the time this is called — this only makes
  // that creation undoable.
  function commitCreate({ layerId, createdVia }) {
    return appendAndPush(
      { action: 'mask-created', beforeState: null, afterState: { layerId, createdVia } },
      { type: 'create', action: 'mask-created', layerId }
    );
  }

  // Single-layer delete (the ✕ button in the Layers panel).
  function commitDelete(layer) {
    removeLayer.mutate(layer.id);
    if (activeLayerId === layer.id) setActiveLayerId(null);
    return appendAndPush(
      { action: 'layer-deleted', beforeState: { layerId: layer.id }, afterState: null },
      { type: 'delete', action: 'layer-deleted', layerId: layer.id }
    );
  }

  // "Clear all paint" — removes every layer on the current asset as one
  // undoable step instead of forcing the user to delete rows one at a time.
  function commitBulkClear(layerIds) {
    if (layerIds.length === 0) return;
    layerIds.forEach((id) => removeLayer.mutate(id));
    if (layerIds.includes(activeLayerId)) setActiveLayerId(null);
    return appendAndPush(
      { action: 'paint-cleared', beforeState: { layerIds }, afterState: null },
      { type: 'bulk-delete', action: 'paint-cleared', layerIds }
    );
  }

  // Undo lands on a command's "before" state; redo lands on its "after"
  // state — the same replay, just in the opposite direction, dispatched by
  // command type rather than assumed to always be a field patch.
  function applyCommand(command, target) {
    switch (command.type) {
      case 'patch':
        return updateLayer.mutate({ layerId: command.layerId, patch: command[target] });
      case 'create':
        return target === 'before' ? removeLayer.mutate(command.layerId) : restoreLayer.mutate(command.layerId);
      case 'delete':
        return target === 'before' ? restoreLayer.mutate(command.layerId) : removeLayer.mutate(command.layerId);
      case 'bulk-delete':
        return command.layerIds.forEach((id) =>
          target === 'before' ? restoreLayer.mutate(id) : removeLayer.mutate(id)
        );
      default:
        return null;
    }
  }

  function undo() {
    if (undoPointer < 0) return;
    applyCommand(undoStack[undoPointer], 'before');
    moveUndoPointer(-1);
  }

  function redo() {
    if (undoPointer >= undoStack.length - 1) return;
    applyCommand(undoStack[undoPointer + 1], 'after');
    moveUndoPointer(1);
  }

  // Scrubbing the History tab: replay every command between the current
  // pointer and the clicked entry, in order, landing exactly on that point.
  function jumpTo(targetIndex) {
    if (targetIndex === undoPointer) return;
    if (targetIndex > undoPointer) {
      for (let i = undoPointer + 1; i <= targetIndex; i++) applyCommand(undoStack[i], 'after');
    } else {
      for (let i = undoPointer; i > targetIndex; i--) applyCommand(undoStack[i], 'before');
    }
    useVisualizerStore.setState({ undoPointer: targetIndex });
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
