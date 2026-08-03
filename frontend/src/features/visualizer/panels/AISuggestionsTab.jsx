import { useEffect, useState } from 'react';
import { extractContextColors, suggestColors } from '../../../shared/lib/colorSuggest';
import { assets as assetsApi } from '../../../shared/lib/api';
import { useLayersList } from '../hooks/useLayers';
import { useHistoryCommand } from '../hooks/useHistoryCommand';
import { useVisualizerStore } from '../store/visualizerStore';
import { useCatalogList } from '../../catalog/useCatalogList';

// Rule-based, explainable suggestions (requirements doc, Section 6.2) —
// samples the photo's *actual unpainted context* outside the active layer's
// mask, not an empty whole-image mask (the AUDIT-flagged bug in v1, where
// "context" sampling included the target surface itself).
export default function AISuggestionsTab({ projectId, assetId, baseImageData, width, height }) {
  const { data: layerList = [] } = useLayersList(assetId);
  const { commit } = useHistoryCommand(projectId, assetId);
  const activeLayerId = useVisualizerStore((s) => s.activeLayerId);
  const setPendingColor = useVisualizerStore((s) => s.setPendingColor);
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(false);
  const { data: catalogData } = useCatalogList({ pageSize: 500 });

  const activeLayer = layerList.find((l) => l.id === activeLayerId);

  async function generate() {
    if (!baseImageData || !activeLayer?.mask_path) return;
    setLoading(true);
    try {
      const maskImg = await loadImage(assetsApi.fileUrl(activeLayer.mask_path));
      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = width;
      maskCanvas.height = height;
      const ctx = maskCanvas.getContext('2d');
      ctx.drawImage(maskImg, 0, 0, width, height);
      const maskData = ctx.getImageData(0, 0, width, height);

      const context = extractContextColors(baseImageData, maskData);
      setSuggestions(suggestColors(context, catalogData?.rows || [], 6));
    } finally {
      setLoading(false);
    }
  }

  function applySuggestion(paint) {
    setPendingColor(paint.id, { r: paint.r_value, g: paint.g_value, b: paint.b_value });
    if (activeLayer) {
      commit({
        action: 'color-applied',
        layerId: activeLayer.id,
        before: { currentColorId: activeLayer.current_color_id },
        after: { currentColorId: paint.id },
      });
    }
  }

  useEffect(() => { setSuggestions([]); }, [activeLayerId]);

  return (
    <div className="p-3">
      {!activeLayer && <p className="text-xs text-[var(--graphite)]">Select a layer to get suggestions for that surface.</p>}
      {activeLayer && (
        <>
          <button
            onClick={generate}
            disabled={loading}
            className="w-full text-sm py-2 mb-3 rounded-[var(--radius-sm)] border border-[var(--line)] hover:bg-[var(--paper)]"
          >
            {loading ? 'Analyzing photo…' : `Suggest colors for "${activeLayer.name}"`}
          </button>
          {suggestions.length > 0 && (
            <div className="grid grid-cols-3 gap-2">
              {suggestions.map((p) => (
                <button key={p.id} onClick={() => applySuggestion(p)} className="text-center">
                  <span className="block w-full h-10 rounded-[var(--radius-sm)] border border-[var(--line)]" style={{ background: p.hex_value }} />
                  <span className="block text-[10px] mt-1 truncate">{p.color_name}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
