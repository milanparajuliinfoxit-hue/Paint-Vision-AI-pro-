import { useState } from 'react';
import { Image, History as HistoryIcon } from 'lucide-react';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from '../../../shared/ui/tooltip';
import AssetsTab from './AssetsTab';
import HistoryTab from './HistoryTab';

// Project-level concerns (photo management, undo history) — everything
// surface/color/scheme-related lives in the right panel (Inspector.jsx),
// per the workspace's AI Schemes / Colors / Surfaces / Adjustments layout.
const SECTIONS = [
  { id: 'assets', label: 'Assets', Icon: Image },
  { id: 'history', label: 'History', Icon: HistoryIcon },
];

export default function SidePanel({ projectId, assetId, undoPointer, onJumpTo, onSelectAsset, width, height }) {
  const [active, setActive] = useState('assets');

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
          {active === 'assets' && <AssetsTab projectId={projectId} activeAssetId={assetId} onSelectAsset={onSelectAsset} width={width} height={height} />}
          {active === 'history' && <HistoryTab projectId={projectId} undoPointer={undoPointer} onJumpTo={onJumpTo} />}
        </div>
      </div>
    </TooltipProvider>
  );
}
