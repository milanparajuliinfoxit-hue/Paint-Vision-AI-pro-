import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { concepts } from '../../../shared/lib/api';
import { useCreateLayer, useLayersList } from './useLayers';
import { useHistoryCommand } from './useHistoryCommand';
import { useVisualizerStore } from '../store/visualizerStore';
import { assets as assetsApi } from '../../../shared/lib/api';
import { surfaceMaskToPngBlob } from '../../../shared/lib/maskImage';

export function useConcepts(projectId) {
  return useQuery({
    queryKey: ['concepts', projectId],
    queryFn: () => concepts.list(projectId),
    enabled: !!projectId,
  });
}

// Saves a named "look" — a thumbnail (the rendered scheme preview) plus the
// surfaceClass -> paintId map. The layerColorMap is what lets a saved concept
// be re-applied as real, editable layers later (not a static image).
export function useSaveConcept(projectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, layerColorMap, thumbnailBlob }) =>
      concepts.create(projectId, { name, layerColorMap }, thumbnailBlob),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['concepts', projectId] }),
  });
}

// Re-applies a saved concept's layerColorMap against the asset's detected
// surfaces — one idempotent AI layer per mapped surface, painted with the
// concept's catalog paints. Same path as applying a scheme, so re-applying
// never duplicates layers and always produces editable layers.
export function useApplyConcept(projectId, assetId, { width, height }) {
  const createLayer = useCreateLayer(assetId);
  const { commitCreate } = useHistoryCommand(projectId, assetId);
  const setActiveLayerId = useVisualizerStore((s) => s.setActiveLayerId);
  const { data: layerList = [] } = useLayersList(assetId);

  async function applyConcept(concept, surfacesByClass) {
    if (!width || !height) return null;
    const colorMap = concept.layer_color_map || concept.layerColorMap || {};
    let index = layerList.length;
    let lastLayer = null;
    for (const [surfaceClass, paintId] of Object.entries(colorMap)) {
      const surface = surfacesByClass.get(surfaceClass);
      if (!surface || surface.paintable === false || !paintId) continue;
      const layer = await createLayer.mutateAsync({
        fields: {
          name: surface.display_name || surfaceClass,
          createdVia: 'ai-surface',
          aiSurfaceKey: surface.class_key,
          aiAnalysisId: surface.analysis_id,
          currentColorId: Number(paintId),
          orderIndex: index++,
        },
        maskBlob: await surfaceMaskToPngBlob(assetsApi.fileUrl(surface.mask_path), width, height),
      });
      lastLayer = layer;
      if (layer._created) commitCreate({ layerId: layer.id, createdVia: 'ai-surface' });
    }
    if (lastLayer) setActiveLayerId(lastLayer.id);
    return lastLayer;
  }

  return { applyConcept };
}
