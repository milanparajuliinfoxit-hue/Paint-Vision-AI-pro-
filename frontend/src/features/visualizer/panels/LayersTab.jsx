import { useState } from 'react';
import { useLayersList } from '../hooks/useLayers';
import { useHistoryCommand } from '../hooks/useHistoryCommand';
import { useVisualizerStore } from '../store/visualizerStore';
import { ConfirmDialog } from '../../../shared/ui/confirmDialog';

export default function LayersTab({ projectId, assetId, colorLookup }) {
  const { data: layerList = [] } = useLayersList(assetId);
  const { commit, commitDelete, commitBulkClear } = useHistoryCommand(projectId, assetId);
  const activeLayerId = useVisualizerStore((s) => s.activeLayerId);
  const selectLayer = useVisualizerStore((s) => s.selectLayer);

  const [pendingDelete, setPendingDelete] = useState(null); // layer object or null
  const [confirmingClear, setConfirmingClear] = useState(false);

  const sorted = [...layerList].sort((a, b) => a.order_index - b.order_index);

  function move(layer, direction) {
    const idx = sorted.findIndex((l) => l.id === layer.id);
    const swapWith = sorted[idx + direction];
    if (!swapWith) return;
    commit({ action: 'order-changed', layerId: layer.id, before: { orderIndex: layer.order_index }, after: { orderIndex: swapWith.order_index } });
    commit({ action: 'order-changed', layerId: swapWith.id, before: { orderIndex: swapWith.order_index }, after: { orderIndex: layer.order_index } });
  }

  if (sorted.length === 0) {
    return <p className="p-3 text-xs text-[var(--graphite)]">No layers yet — use a selection tool on the canvas to create one.</p>;
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-2 pt-2 pb-1">
        <span className="text-[10px] uppercase text-[var(--graphite)]">{sorted.length} layer{sorted.length === 1 ? '' : 's'}</span>
        <button onClick={() => setConfirmingClear(true)} className="text-[11px] text-[var(--danger)] hover:underline">
          Clear all paint
        </button>
      </div>

      <ul role="listbox" aria-label="Layers" className="p-2 pt-0 flex flex-col gap-1 overflow-y-auto">
        {sorted.map((layer, i) => {
          const rgb = colorLookup(layer.current_color_id);
          return (
            <li
              key={layer.id}
              role="option"
              aria-selected={activeLayerId === layer.id}
              tabIndex={0}
              onClick={() => selectLayer(layer.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectLayer(layer.id); } }}
              className={`flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 cursor-pointer text-sm ${
                activeLayerId === layer.id ? 'bg-[var(--signal)]/10 border border-[var(--signal)]' : 'hover:bg-[var(--paper)]'
              }`}
            >
              <span
                className="w-4 h-4 rounded-full border border-[var(--line)] shrink-0"
                style={{ background: rgb ? `rgb(${rgb.r},${rgb.g},${rgb.b})` : 'transparent' }}
              />
              <span className="flex-1 truncate">{layer.name}</span>

              <button
                aria-label={layer.visible ? 'Hide layer' : 'Show layer'}
                onClick={(e) => {
                  e.stopPropagation();
                  commit({ action: 'visibility-changed', layerId: layer.id, before: { visible: layer.visible }, after: { visible: !layer.visible } });
                }}
                className="text-xs w-5"
              >
                {layer.visible ? '👁' : '—'}
              </button>
              <button
                aria-label={layer.locked ? 'Unlock layer' : 'Lock layer'}
                onClick={(e) => {
                  e.stopPropagation();
                  commit({ action: 'lock-changed', layerId: layer.id, before: { locked: layer.locked }, after: { locked: !layer.locked } });
                }}
                className="text-xs w-5"
              >
                {layer.locked ? '🔒' : '🔓'}
              </button>
              <button aria-label="Move up" disabled={i === 0} onClick={(e) => { e.stopPropagation(); move(layer, -1); }} className="text-xs w-4 disabled:opacity-30">↑</button>
              <button aria-label="Move down" disabled={i === sorted.length - 1} onClick={(e) => { e.stopPropagation(); move(layer, 1); }} className="text-xs w-4 disabled:opacity-30">↓</button>
              <button
                aria-label="Delete layer"
                onClick={(e) => { e.stopPropagation(); setPendingDelete(layer); }}
                className="text-xs text-[var(--danger)] w-4"
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title="Delete this layer?"
        description="Removes this painted surface. You can undo this from the toolbar or the History panel."
        confirmLabel="Delete"
        destructive
        onConfirm={() => { commitDelete(pendingDelete); setPendingDelete(null); }}
      />

      <ConfirmDialog
        open={confirmingClear}
        onOpenChange={setConfirmingClear}
        title="Clear all paint on this photo?"
        description={`Removes all ${sorted.length} layer${sorted.length === 1 ? '' : 's'} on this photo. This is a single undoable step.`}
        confirmLabel="Clear all paint"
        destructive
        onConfirm={() => commitBulkClear(sorted.map((l) => l.id))}
      />
    </div>
  );
}
