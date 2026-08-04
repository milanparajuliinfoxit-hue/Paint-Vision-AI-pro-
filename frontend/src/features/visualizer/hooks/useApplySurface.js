import { useCreateLayer, useLayersList } from './useLayers';
import { useHistoryCommand } from './useHistoryCommand';
import { useVisualizerStore } from '../store/visualizerStore';
import { assets as assetsApi } from '../../../shared/lib/api';

// Applies AI-understanding results as real layers.
//
// The renderer stays authoritative: applying a detected surface or a scheme
// creates ordinary layers through the standard layers API (createdVia
// 'ai-surface', ai_surface_key set) with the surface's mask upscaled to the
// canvas resolution and the scheme's catalog paint — exactly the same
// pipeline as a hand-drawn brush layer. Undo/redo work on these layers like
// any other, because they are layers.
export function useApplySurface(projectId, assetId, { width, height }) {
  const createLayer = useCreateLayer(assetId);
  const { commitCreate } = useHistoryCommand(projectId, assetId);
  const setActiveLayerId = useVisualizerStore((s) => s.setActiveLayerId);
  const { data: layerList = [] } = useLayersList(assetId);

  // One detected surface -> one layer, painted with an optional catalog paint.
  async function applySurface(surface, paint) {
    if (!width || !height || !surface?.mask_path) return null;
    const blob = await surfaceMaskToPngBlob(assetsApi.fileUrl(surface.mask_path), width, height);
    const layer = await createLayer.mutateAsync({
      fields: {
        name: surface.display_name || surface.class_key,
        createdVia: 'ai-surface',
        aiSurfaceKey: surface.class_key,
        currentColorId: paint?.id || undefined,
        orderIndex: layerList.length,
      },
      maskBlob: blob,
    });
    setActiveLayerId(layer.id);
    commitCreate({ layerId: layer.id, createdVia: 'ai-surface' });
    return layer;
  }

  // A whole scheme -> one layer per paintable surface, each painted with the
  // scheme's mapped catalog paint. Non-paintable surfaces are skipped by
  // construction — a scheme never paints a window, tree, or neighbor house.
  async function applyScheme(scheme, surfacesByClass) {
    let index = layerList.length;
    let lastLayer = null;
    for (const entry of scheme.surfaces || []) {
      const surface = surfacesByClass.get(entry.surfaceClass);
      if (!surface || surface.paintable === false) continue;
      const layer = await createLayer.mutateAsync({
        fields: {
          name: surface.display_name || entry.surfaceClass,
          createdVia: 'ai-surface',
          aiSurfaceKey: surface.class_key,
          currentColorId: entry.paint?.id || undefined,
          orderIndex: index++,
        },
        maskBlob: await surfaceMaskToPngBlob(assetsApi.fileUrl(surface.mask_path), width, height),
      });
      lastLayer = layer;
      commitCreate({ layerId: layer.id, createdVia: 'ai-surface' });
    }
    if (lastLayer) setActiveLayerId(lastLayer.id);
    return lastLayer;
  }

  return { applySurface, applyScheme };
}

// Draws the analysis-resolution alpha mask up onto a full-resolution canvas
// and encodes it as a PNG blob — the same read-scale-encode path layer masks
// already use, so the renderer never cares that the AI ran at 640px.
function surfaceMaskToPngBlob(url, width, height) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Mask encoding failed'))), 'image/png');
    };
    img.onerror = reject;
    img.src = url;
  });
}
