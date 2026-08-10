import { useState } from 'react';
import CatalogTab from './CatalogTab';
import AISuggestionsTab from './AISuggestionsTab';
import FavoritesTab from './FavoritesTab';
import BrandsTab from './BrandsTab';
import CollectionsTab from './CollectionsTab';
import FinishesTab from './FinishesTab';

const SUB_TABS = [
  { id: 'catalog', label: 'Catalog' },
  { id: 'suggestions', label: 'Suggestions' },
  { id: 'favorites', label: 'Favorites' },
  { id: 'brands', label: 'Brands' },
  { id: 'collections', label: 'Collections' },
  { id: 'finishes', label: 'Finishes' },
];

// Every way to find a paint, grouped under one "Colors" tab.
export default function ColorsTab({ projectId, assetId, baseImageData, width, height }) {
  const [sub, setSub] = useState('catalog');

  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-1 border-b border-[var(--line)] px-2 pt-2 overflow-x-auto">
        {SUB_TABS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setSub(id)}
            className={`shrink-0 px-2.5 py-1.5 text-xs font-medium rounded-t-[var(--radius-sm)] border-b-2 ${
              sub === id ? 'border-[var(--signal)] text-[var(--ink)]' : 'border-transparent text-[var(--graphite)]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {/* overflow-hidden: Catalog/Favorites/Brands/Collections/Finishes each
          manage their own internal h-full + overflow-y-auto scroll region
          (same pattern as the old SidePanel's content pane) — this div must
          only bound their height, not also scroll, or the two scroll
          containers fight over height resolution. AISuggestionsTab is a
          plain block with no scroll region of its own, so it gets an
          individual overflow-y-auto wrapper instead. */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {sub === 'catalog' && <CatalogTab projectId={projectId} assetId={assetId} />}
        {sub === 'suggestions' && (
          <div className="h-full overflow-y-auto">
            <AISuggestionsTab projectId={projectId} assetId={assetId} baseImageData={baseImageData} width={width} height={height} />
          </div>
        )}
        {sub === 'favorites' && <FavoritesTab projectId={projectId} assetId={assetId} />}
        {sub === 'brands' && <BrandsTab projectId={projectId} assetId={assetId} />}
        {sub === 'collections' && <CollectionsTab projectId={projectId} assetId={assetId} />}
        {sub === 'finishes' && <FinishesTab assetId={assetId} />}
      </div>
    </div>
  );
}
