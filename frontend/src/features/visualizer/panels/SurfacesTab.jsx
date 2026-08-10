import { useState } from 'react';
import AIAnalyzeTab from './AIAnalyzeTab';
import LayersTab from './LayersTab';

const SUB_TABS = [
  { id: 'ai-understand', label: 'AI Understand' },
  { id: 'layers', label: 'Layers' },
];

// Detected surfaces (AI Understand) and the editable layer list — both are
// "what can I paint on this photo," just at different stages (detection vs.
// the real layers a dealer is actively editing).
export default function SurfacesTab({ projectId, assetId, width, height, colorLookup }) {
  const [sub, setSub] = useState('ai-understand');

  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-1 border-b border-[var(--line)] px-2 pt-2">
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
      {/* overflow-hidden: LayersTab manages its own internal h-full +
          overflow-y-auto scroll region — this div must only bound its
          height, not also scroll. AIAnalyzeTab is a plain block with no
          scroll region of its own, so it gets an individual
          overflow-y-auto wrapper instead (same reasoning as ColorsTab). */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {sub === 'ai-understand' && (
          <div className="h-full overflow-y-auto">
            <AIAnalyzeTab projectId={projectId} assetId={assetId} width={width} height={height} />
          </div>
        )}
        {sub === 'layers' && <LayersTab projectId={projectId} assetId={assetId} colorLookup={colorLookup} />}
      </div>
    </div>
  );
}
