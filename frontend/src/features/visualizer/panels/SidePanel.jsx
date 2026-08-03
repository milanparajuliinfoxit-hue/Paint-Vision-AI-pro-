import { useState } from 'react';
import { Image, Layers, History as HistoryIcon, Sparkles, Palette, Star, Bookmark, Tag, Droplet } from 'lucide-react';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from '../../../shared/ui/tooltip';
import AssetsTab from './AssetsTab';
import LayersTab from './LayersTab';
import HistoryTab from './HistoryTab';
import AISuggestionsTab from './AISuggestionsTab';
import CatalogTab from './CatalogTab';
import FavoritesTab from './FavoritesTab';
import CollectionsTab from './CollectionsTab';
import BrandsTab from './BrandsTab';
import FinishesTab from './FinishesTab';

const SECTIONS = [
  { id: 'assets', label: 'Assets', Icon: Image },
  { id: 'layers', label: 'Layers', Icon: Layers },
  { id: 'history', label: 'History', Icon: HistoryIcon },
  { id: 'ai', label: 'AI', Icon: Sparkles },
  { id: 'catalog', label: 'Paint Catalog', Icon: Palette },
  { id: 'favorites', label: 'Favorites', Icon: Star },
  { id: 'collections', label: 'Collections', Icon: Bookmark },
  { id: 'brands', label: 'Brands', Icon: Tag },
  { id: 'finishes', label: 'Finishes', Icon: Droplet },
];

// One side panel, one nav — replaces the old per-concern tab strips. Only the
// content pane swaps when a section is clicked; the icon rail itself never
// changes shape (requirements doc, Phase 3).
export default function SidePanel({ projectId, assetId, colorLookup, undoPointer, onJumpTo, onSelectAsset, baseImageData, width, height }) {
  const [active, setActive] = useState('layers');

  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex h-full">
        <nav className="flex flex-col items-center gap-1 w-12 shrink-0 border-r border-[var(--line)] bg-[var(--paper)] py-2">
          {SECTIONS.map(({ id, label, Icon }) => (
            <Tooltip key={id}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setActive(id)}
                  aria-label={label}
                  aria-current={active === id}
                  className={`flex items-center justify-center h-9 w-9 rounded-[var(--radius-sm)] transition-colors ${
                    active === id ? 'bg-[var(--signal)] text-white' : 'text-[var(--graphite)] hover:bg-[var(--paper-raised)] hover:text-[var(--ink)]'
                  }`}
                >
                  <Icon size={17} strokeWidth={2} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">{label}</TooltipContent>
            </Tooltip>
          ))}
        </nav>

        <div className="flex-1 min-w-0 overflow-hidden">
          {active === 'assets' && <AssetsTab projectId={projectId} activeAssetId={assetId} onSelectAsset={onSelectAsset} />}
          {active === 'layers' && <LayersTab projectId={projectId} assetId={assetId} colorLookup={colorLookup} />}
          {active === 'history' && <HistoryTab projectId={projectId} undoPointer={undoPointer} onJumpTo={onJumpTo} />}
          {active === 'ai' && <AISuggestionsTab projectId={projectId} assetId={assetId} baseImageData={baseImageData} width={width} height={height} />}
          {active === 'catalog' && <CatalogTab projectId={projectId} assetId={assetId} />}
          {active === 'favorites' && <FavoritesTab projectId={projectId} assetId={assetId} />}
          {active === 'collections' && <CollectionsTab projectId={projectId} assetId={assetId} />}
          {active === 'brands' && <BrandsTab projectId={projectId} assetId={assetId} />}
          {active === 'finishes' && <FinishesTab assetId={assetId} />}
        </div>
      </div>
    </TooltipProvider>
  );
}
