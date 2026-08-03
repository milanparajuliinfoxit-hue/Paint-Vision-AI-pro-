import { useMemo, useState } from 'react';
import { useCatalogList } from '../../catalog/useCatalogList';
import { useFavorites } from '../../catalog/useFavorites';
import { useApplyColor } from '../hooks/useApplyColor';
import { useVisualizerStore } from '../store/visualizerStore';
import ColorGrid from './ColorGrid';

// "Brand" maps to the product-line flags already in the catalog schema
// (tenprotect/brightshine/etc.) — the same mapping PaintCard and the
// catalog page use, rather than fabricating a brand column that doesn't
// exist in the data.
const PRODUCT_LINES = ['tenprotect', 'brightshine', 'colorfuleco', 'jotashield', 'majestic', 'sevenprotect', 'surprised'];

export default function BrandsTab({ projectId, assetId }) {
  const { data: catalogData } = useCatalogList({ pageSize: 2000 });
  const { isFavorite, toggleFavorite, markRecentlyUsed } = useFavorites();
  const { pickColor, hoverColor } = useApplyColor(projectId, assetId);
  const pendingColorId = useVisualizerStore((s) => s.pendingColorId);
  const [activeLine, setActiveLine] = useState(PRODUCT_LINES[0]);

  const rows = useMemo(
    () => (catalogData?.rows || []).filter((p) => p[activeLine]),
    [catalogData, activeLine]
  );

  function pick(paint) {
    markRecentlyUsed({ id: paint.id, color_name: paint.color_name, color_code: paint.color_code, hex_value: paint.hex_value });
    pickColor(paint);
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-wrap gap-1 p-2 border-b border-[var(--line)]">
        {PRODUCT_LINES.map((line) => (
          <button
            key={line}
            onClick={() => setActiveLine(line)}
            className={`text-[11px] px-2 py-1 rounded-[var(--radius-sm)] capitalize ${
              activeLine === line ? 'bg-[var(--signal)] text-white' : 'bg-[var(--paper)] text-[var(--graphite)] hover:text-[var(--ink)]'
            }`}
          >
            {line}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto">
        <ColorGrid
          rows={rows}
          pendingColorId={pendingColorId}
          isFavorite={isFavorite}
          onToggleFavorite={toggleFavorite}
          onPick={pick}
          onHover={hoverColor}
          emptyMessage="No colors in this product line."
        />
      </div>
    </div>
  );
}
