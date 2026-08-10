import { useEffect, useState } from 'react';
import RecommendationsTab from './RecommendationsTab';
import ColorsTab from './ColorsTab';
import SurfacesTab from './SurfacesTab';
import AdjustmentsTab from './AdjustmentsTab';
import { useVisualizerStore } from '../store/visualizerStore';

const TABS = [
  { id: 'ai-schemes', label: 'AI Schemes' },
  { id: 'colors', label: 'Colors' },
  { id: 'surfaces', label: 'Surfaces' },
  { id: 'adjustments', label: 'Adjustments' },
];

// Right panel: AI Schemes / Colors / Surfaces / Adjustments. AI Schemes is
// the default tab — a dealer lands on the AI's recommendations first, not a
// tool inspector, once there's something to look at.
export default function Inspector({ projectId, assetId, width, height, baseImageData, colorLookup, onOpenExport }) {
  const [active, setActive] = useState('ai-schemes');
  const activeTool = useVisualizerStore((s) => s.activeTool);

  // Brush/eraser options (size, mode, "select a layer first") live in
  // Adjustments — jump there the moment either tool is picked, or their
  // controls are invisible until the dealer happens to click over
  // manually (previously reachable as the misread-as-broken "eraser does
  // nothing" complaint). Only fires on the tool *becoming* brush/eraser, so
  // a dealer who then deliberately switches to another tab isn't fought.
  useEffect(() => {
    if (activeTool === 'brush' || activeTool === 'eraser') setActive('adjustments');
  }, [activeTool]);

  return (
    <div className="w-[300px] shrink-0 border-l border-[var(--line)] bg-[var(--paper-raised)] flex flex-col h-full overflow-hidden">
      <div className="flex border-b border-[var(--line)]">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setActive(id)}
            aria-current={active === id}
            className={`flex-1 px-2 py-2.5 text-xs font-medium border-b-2 transition-colors ${
              active === id
                ? 'border-[var(--signal)] text-[var(--ink)]'
                : 'border-transparent text-[var(--graphite)] hover:text-[var(--ink)]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* overflow-hidden, not overflow-y-auto: ColorsTab/SurfacesTab manage
          their own internal scroll region (same h-full + flex-1
          overflow-y-auto pattern as CatalogTab/LayersTab), so this pane must
          only bound their height, not also scroll — two nested scroll
          containers fight over height resolution. RecommendationsTab and
          AdjustmentsTab don't self-scroll, so each gets its own
          h-full overflow-y-auto wrapper instead. */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {active === 'ai-schemes' && (
          <div className="h-full overflow-y-auto">
            <RecommendationsTab projectId={projectId} assetId={assetId} width={width} height={height} baseImageData={baseImageData} />
          </div>
        )}
        {active === 'colors' && (
          <ColorsTab projectId={projectId} assetId={assetId} baseImageData={baseImageData} width={width} height={height} />
        )}
        {active === 'surfaces' && (
          <SurfacesTab projectId={projectId} assetId={assetId} width={width} height={height} colorLookup={colorLookup} />
        )}
        {active === 'adjustments' && (
          <div className="h-full overflow-y-auto">
            <AdjustmentsTab projectId={projectId} assetId={assetId} />
          </div>
        )}
      </div>

      <div className="border-t border-[var(--line)] p-3">
        <button onClick={onOpenExport} className="w-full text-sm py-2 rounded-[var(--radius-sm)] bg-[var(--signal)] text-white font-medium">
          Export
        </button>
      </div>
    </div>
  );
}
