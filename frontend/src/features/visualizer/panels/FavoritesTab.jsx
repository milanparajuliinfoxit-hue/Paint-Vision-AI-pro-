import { useMemo } from 'react';
import { useCatalogList } from '../../catalog/useCatalogList';
import { useFavorites } from '../../catalog/useFavorites';
import { useApplyColor } from '../hooks/useApplyColor';
import { useVisualizerStore } from '../store/visualizerStore';
import ColorGrid from './ColorGrid';

export default function FavoritesTab({ projectId, assetId }) {
  const { data: catalogData } = useCatalogList({ pageSize: 2000 });
  const { isFavorite, toggleFavorite, markRecentlyUsed, recentPaints } = useFavorites();
  const { pickColor, hoverColor } = useApplyColor(projectId, assetId);
  const pendingColorId = useVisualizerStore((s) => s.pendingColorId);

  const rows = useMemo(() => (catalogData?.rows || []).filter((p) => isFavorite(p.id)), [catalogData, isFavorite]);

  function pick(paint) {
    markRecentlyUsed(paint);
    pickColor(paint);
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {recentPaints.length > 0 && (
        <div className="p-2 border-b border-[var(--line)]">
          <h3 className="text-[10px] uppercase text-[var(--graphite)] mb-1.5">Recently used</h3>
          <div className="flex items-center gap-1.5 overflow-x-auto py-0.5">
            {recentPaints.map((p) => (
              <button
                key={p.id}
                title={`${p.color_name} (${p.color_code})`}
                onClick={() => pick(p)}
                className="h-6 w-6 shrink-0 rounded-full border border-[var(--line)] transition-transform hover:scale-110"
                style={{ background: p.hex_value }}
                aria-label={`Recent: ${p.color_name}`}
              />
            ))}
          </div>
        </div>
      )}
      <ColorGrid
        rows={rows}
        pendingColorId={pendingColorId}
        isFavorite={isFavorite}
        onToggleFavorite={toggleFavorite}
        onPick={pick}
        onHover={hoverColor}
        emptyMessage="No favorites yet — star a color in the Catalog to save it here."
      />
    </div>
  );
}
