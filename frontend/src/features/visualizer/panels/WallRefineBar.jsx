import React from 'react';
import { useVisualizerStore } from '../store/visualizerStore';
import { Button } from '../../../shared/ui/button';
import { cn } from '../../../shared/lib/cn';
import { Plus, Minus, Paintbrush, Layers, Trash2, Check } from 'lucide-react';

const FINISH_OPTIONS = [
  { id: 'matte', label: 'Matte' },
  { id: 'eggshell', label: 'Eggshell' },
  { id: 'satin', label: 'Satin' },
  { id: 'gloss', label: 'Gloss' },
];

export default function WallRefineBar({ onApplyLayer, onClear }) {
  const activeTool = useVisualizerStore((s) => s.activeTool);
  const activeMask = useVisualizerStore((s) => s.aiWallActiveMask);
  const refineMode = useVisualizerStore((s) => s.aiWallRefineMode);
  const finish = useVisualizerStore((s) => s.aiWallFinish);
  const isSegmenting = useVisualizerStore((s) => s.aiWallIsSegmenting);

  const setRefineMode = useVisualizerStore((s) => s.setAiWallRefineMode);
  const setFinish = useVisualizerStore((s) => s.setAiWallFinish);

  if (activeTool !== 'ai-wall' && !activeMask) {
    return null;
  }

  return (
    <div
      className={cn(
        'absolute bottom-6 left-1/2 -translate-x-1/2 z-40',
        'flex items-center gap-2 px-4 py-2.5 rounded-full shadow-2xl',
        'bg-neutral-900/90 backdrop-blur-md border border-neutral-700/80 text-white',
        'transition-all duration-300 animate-in fade-in slide-in-from-bottom-4'
      )}
      style={{ minHeight: '52px' }}
    >
      <div className="flex items-center gap-1 border-r border-neutral-700 pr-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-blue-400 mr-1 flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
          AI Wall
        </span>

        {/* Add (+) Mode */}
        <button
          type="button"
          onClick={() => setRefineMode('add')}
          className={cn(
            'min-w-[44px] min-h-[44px] px-3 py-2 rounded-full text-xs font-medium flex items-center gap-1.5 transition-colors',
            refineMode === 'add'
              ? 'bg-blue-600 text-white shadow-md'
              : 'hover:bg-neutral-800 text-neutral-300'
          )}
          title="Add Wall Region (+ Click)"
        >
          <Plus className="w-4 h-4" />
          <span>Add</span>
        </button>

        {/* Subtract (-) Mode */}
        <button
          type="button"
          onClick={() => setRefineMode('remove')}
          className={cn(
            'min-w-[44px] min-h-[44px] px-3 py-2 rounded-full text-xs font-medium flex items-center gap-1.5 transition-colors',
            refineMode === 'remove'
              ? 'bg-red-600 text-white shadow-md'
              : 'hover:bg-neutral-800 text-neutral-300'
          )}
          title="Subtract Wall Region (- Click)"
        >
          <Minus className="w-4 h-4" />
          <span>Subtract</span>
        </button>

        {/* Edge Brush */}
        <button
          type="button"
          onClick={() => setRefineMode('brush')}
          className={cn(
            'min-w-[44px] min-h-[44px] px-3 py-2 rounded-full text-xs font-medium flex items-center gap-1.5 transition-colors',
            refineMode === 'brush'
              ? 'bg-amber-600 text-white shadow-md'
              : 'hover:bg-neutral-800 text-neutral-300'
          )}
          title="Edge Tune Brush"
        >
          <Paintbrush className="w-4 h-4" />
          <span>Edge Brush</span>
        </button>
      </div>

      {/* Finish Selector */}
      <div className="flex items-center gap-1 border-r border-neutral-700 pr-3">
        <span className="text-xs text-neutral-400 font-medium px-1">Finish:</span>
        <div className="flex bg-neutral-800 p-1 rounded-full border border-neutral-700">
          {FINISH_OPTIONS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFinish(f.id)}
              className={cn(
                'min-w-[44px] min-h-[36px] px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
                finish === f.id
                  ? 'bg-neutral-100 text-neutral-900 font-bold shadow'
                  : 'text-neutral-300 hover:text-white'
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 pl-1">
        {onClear && (
          <button
            type="button"
            onClick={onClear}
            className="min-w-[44px] min-h-[44px] px-3 py-2 rounded-full text-xs font-medium text-neutral-400 hover:text-red-400 hover:bg-neutral-800 transition-colors flex items-center gap-1"
            title="Clear Selection"
          >
            <Trash2 className="w-4 h-4" />
            <span className="hidden sm:inline">Clear</span>
          </button>
        )}

        {onApplyLayer && (
          <button
            type="button"
            onClick={onApplyLayer}
            disabled={!activeMask || isSegmenting}
            className={cn(
              'min-w-[44px] min-h-[44px] px-4 py-2 rounded-full text-xs font-bold flex items-center gap-1.5 transition-all shadow-lg',
              activeMask && !isSegmenting
                ? 'bg-emerald-500 hover:bg-emerald-400 text-neutral-950 hover:scale-105 active:scale-95'
                : 'bg-neutral-800 text-neutral-500 cursor-not-allowed'
            )}
          >
            <Check className="w-4 h-4 stroke-[3]" />
            <span>Apply Wall Paint</span>
          </button>
        )}
      </div>
    </div>
  );
}
