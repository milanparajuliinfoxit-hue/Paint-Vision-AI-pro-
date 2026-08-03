import { useLayersList } from './useLayers';
import { useHistoryCommand } from './useHistoryCommand';
import { useVisualizerStore } from '../store/visualizerStore';

// Shared "pick a catalog color" behavior for every color-browsing panel
// (Catalog/Favorites/Brands/Collections tabs, and the tool inspector):
// commits the color to the active layer on click, and drives the low-latency
// canvas hover preview without committing (requirements doc, Section 6.1).
// Routed through the undo/redo command stack — applying a color is the
// single most common paint action, so it must be undoable like any other.
export function useApplyColor(projectId, assetId) {
  const { data: layerList = [] } = useLayersList(assetId);
  const { commit } = useHistoryCommand(projectId, assetId);
  const activeLayerId = useVisualizerStore((s) => s.activeLayerId);
  const setPendingColor = useVisualizerStore((s) => s.setPendingColor);
  const setHoverPreviewColorRgb = useVisualizerStore((s) => s.setHoverPreviewColorRgb);
  const activeLayer = layerList.find((l) => l.id === activeLayerId);

  function pickColor(paint) {
    setPendingColor(paint.id, { r: paint.r_value, g: paint.g_value, b: paint.b_value });
    setHoverPreviewColorRgb(null);
    if (activeLayer) {
      commit({
        action: 'color-applied',
        layerId: activeLayer.id,
        before: { currentColorId: activeLayer.current_color_id },
        after: { currentColorId: paint.id },
      });
    }
  }

  function hoverColor(paint) {
    setHoverPreviewColorRgb(paint ? { r: paint.r_value, g: paint.g_value, b: paint.b_value } : null);
  }

  return { pickColor, hoverColor, activeLayer };
}
