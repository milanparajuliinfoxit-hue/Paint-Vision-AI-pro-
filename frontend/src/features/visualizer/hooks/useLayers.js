import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { layers } from '../../../shared/lib/api';

export function useLayersList(assetId) {
  return useQuery({
    queryKey: ['layers', assetId],
    queryFn: () => layers.list(assetId),
    enabled: !!assetId,
  });
}

export function useCreateLayer(assetId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ fields, maskBlob }) => layers.create(assetId, fields, maskBlob),
    meta: { action: 'Creating layer' },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['layers', assetId] }),
  });
}

// Optimistic: the cache updates synchronously so the Konva canvas re-renders
// the single affected layer immediately — no "Apply" click, no waiting on
// the network round trip (requirements doc, Section 5.2/14).
export function useUpdateLayer(assetId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ layerId, patch, updatedAt, maskBlob }) => layers.update(layerId, patch, updatedAt, maskBlob),
    meta: { action: 'Saving layer change' },
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

export function useDeleteLayer(assetId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (layerId) => layers.remove(layerId),
    meta: { action: 'Deleting layer' },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['layers', assetId] }),
  });
}

// Undo of a delete / redo of a create — brings a soft-deleted layer back.
export function useRestoreLayer(assetId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (layerId) => layers.restore(layerId),
    meta: { action: 'Restoring layer' },
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
