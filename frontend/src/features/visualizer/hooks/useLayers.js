import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { layers } from '../../../shared/lib/api';
import { logger } from '../../../shared/lib/logger';
import { upsertById } from './layerCacheUtils';

export function useLayersList(assetId) {
  return useQuery({
    queryKey: ['layers', assetId],
    queryFn: () => layers.list(assetId),
    enabled: !!assetId,
  });
}

// onSuccess writes the real created layer straight into the cache instead
// of invalidating — the server response already *is* the authoritative
// row, so a follow-up refetch would just be a second network round trip
// for data we already have in hand. Must dedupe by id, not just append:
// this same hook backs the AI-surface idempotent upsert path
// (useApplySurface.js) — re-applying an already-applied surface/scheme
// returns an *update* to an existing layer (created._created === false),
// not a new one, and a blind append would leave a stale duplicate of that
// layer sitting in the cache alongside its updated copy.
export function useCreateLayer(assetId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ fields, maskBlob }) => layers.create(assetId, fields, maskBlob),
    onSuccess: (created) => {
      queryClient.setQueryData(['layers', assetId], (old = []) => upsertById(old, created));
    },
  });
}

// Optimistic: the cache updates synchronously so the Konva canvas re-renders
// the single affected layer immediately — no "Apply" click, no waiting on
// the network round trip (requirements doc, Section 5.2/14).
export function useUpdateLayer(assetId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ layerId, patch, updatedAt, maskBlob }) => layers.update(layerId, patch, updatedAt, maskBlob),
    onMutate: async ({ layerId, patch }) => {
      await queryClient.cancelQueries({ queryKey: ['layers', assetId] });
      const previous = queryClient.getQueryData(['layers', assetId]);
      queryClient.setQueryData(['layers', assetId], (old = []) =>
        old.map((l) => (l.id === layerId ? { ...l, ...toSnakeCasePatch(patch) } : l))
      );
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(['layers', assetId], context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['layers', assetId] }),
  });
}

// Optimistic removal — the layer leaves the Layers panel and the canvas
// (both read this same query) the instant delete is requested, not once
// the DELETE request round-trips. This is the one deletion mechanism used
// both by the manual Layers-panel delete button and by the eraser's
// auto-delete-on-empty path (see VisualizerWorkspace's eraseFromLayer) —
// intentionally not duplicated.
export function useDeleteLayer(assetId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (layerId) => layers.remove(layerId),
    onMutate: async (layerId) => {
      await queryClient.cancelQueries({ queryKey: ['layers', assetId] });
      const previous = queryClient.getQueryData(['layers', assetId]);
      queryClient.setQueryData(['layers', assetId], (old = []) => old.filter((l) => l.id !== layerId));
      return { previous };
    },
    onError: (err, layerId, context) => {
      // A failed delete must not silently leave the layer looking gone —
      // restore the optimistic removal and say so, rather than the user
      // discovering data loss on next reload.
      if (context?.previous) queryClient.setQueryData(['layers', assetId], context.previous);
      logger.error('layer.delete.failed', { layerId, message: err?.message });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['layers', assetId] }),
  });
}

// Undo of a delete / redo of a create — brings a soft-deleted layer back.
export function useRestoreLayer(assetId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (layerId) => layers.restore(layerId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['layers', assetId] }),
  });
}

// The API patch body is camelCase; the cached rows (straight from MySQL) are
// snake_case — mirror the rename so the optimistic merge actually matches
// the fields LayerNode reads for rendering.
function toSnakeCasePatch(patch) {
  const map = {
    currentColorId: 'current_color_id',
    finishOverride: 'finish_override',
    orderIndex: 'order_index',
    maskPath: 'mask_path',
  };
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    out[map[key] || key] = value;
  }
  return out;
}
