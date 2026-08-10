import { useMemo, useState } from 'react';
import { useCatalogList } from '../../catalog/useCatalogList';
import { useFavorites } from '../../catalog/useFavorites';
import { useApplyColor } from '../hooks/useApplyColor';
import { useVisualizerStore } from '../store/visualizerStore';
import ColorGrid from './ColorGrid';

export default function CatalogTab({ projectId, assetId }) {
  const { data: catalogData } = useCatalogList({ pageSize: 2000 });
  const { isFavorite, toggleFavorite, markRecentlyUsed } = useFavorites();
  const { pickColor, hoverColor, activeLayer } = useApplyColor(projectId, assetId);
  const pendingColorId = useVisualizerStore((s) => s.pendingColorId);
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const list = catalogData?.rows || [];
    if (!query.trim()) return list;
    const q = query.trim().toLowerCase();
    return list.filter((p) => p.color_name.toLowerCase().includes(q) || p.color_code.toLowerCase().includes(q));
  }, [catalogData, query]);

  function pick(paint) {
    markRecentlyUsed(paint);
    pickColor(paint);
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-2 border-b border-[var(--line)]">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name or code…"
          aria-label="Search catalog"
          className="w-full text-xs rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--paper)] px-2 py-1.5 outline-none focus:border-[var(--signal)]"
        />
        {!activeLayer && <p className="text-[10px] text-[var(--graphite)] mt-1.5">Select a layer to apply a color to it.</p>}
      </div>
      <div className="flex-1 overflow-y-auto">
        <ColorGrid
          rows={rows}
          pendingColorId={pendingColorId}
          isFavorite={isFavorite}
          onToggleFavorite={toggleFavorite}
          onPick={pick}
          onHover={hoverColor}
          emptyMessage="No colors match your search."
        />
      </div>
    </div>
  );
}
