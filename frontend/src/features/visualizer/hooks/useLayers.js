import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { layers } from '../../../shared/lib/api';
import { useInvalidatingMutation } from '../../../shared/lib/useInvalidatingMutation';

const layersKey = (assetId) => ['layers', assetId];

export function useLayersList(assetId) {
  return useQuery({
    queryKey: layersKey(assetId),
    queryFn: () => layers.list(assetId),
    enabled: !!assetId,
  });
}

export function useCreateLayer(assetId) {
  return useInvalidatingMutation(
    ({ fields, maskBlob }) => layers.create(assetId, fields, maskBlob),
    layersKey(assetId)
  );
}

// Optimistic: the cache updates synchronously so the Konva canvas re-renders
// the single affected layer immediately — no "Apply" click, no waiting on
// the network round trip (requirements doc, Section 5.2/14).
export function useUpdateLayer(assetId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ layerId, patch, updatedAt, maskBlob }) => layers.update(layerId, patch, updatedAt, maskBlob),
    onMutate: async ({ layerId, patch }) => {
      await queryClient.cancelQueries({ queryKey: layersKey(assetId) });
      const previous = queryClient.getQueryData(layersKey(assetId));
      queryClient.setQueryData(layersKey(assetId), (old = []) =>
        old.map((l) => (l.id === layerId ? { ...l, ...toSnakeCasePatch(patch) } : l))
      );
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(layersKey(assetId), context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: layersKey(assetId) }),
  });
}

export function useDeleteLayer(assetId) {
  return useInvalidatingMutation((layerId) => layers.remove(layerId), layersKey(assetId));
}

// Undo of a delete / redo of a create — brings a soft-deleted layer back.
export function useRestoreLayer(assetId) {
  return useInvalidatingMutation((layerId) => layers.restore(layerId), layersKey(assetId));
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
