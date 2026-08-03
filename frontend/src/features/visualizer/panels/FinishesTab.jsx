import { useMemo } from 'react';
import { useLayersList } from '../hooks/useLayers';
import { useVisualizerStore } from '../store/visualizerStore';

// The catalog has no per-color "finish" attribute — finish is chosen per
// layer at application time (layers.finish_override), so this section
// groups the *current asset's* layers by the finish actually set on them,
// rather than fabricating a catalog-wide finish taxonomy that doesn't exist
// in the data.
export default function FinishesTab({ assetId }) {
  const { data: layerList = [] } = useLayersList(assetId);
  const activeLayerId = useVisualizerStore((s) => s.activeLayerId);
  const setActiveLayerId = useVisualizerStore((s) => s.setActiveLayerId);

  const groups = useMemo(() => {
    const byFinish = new Map();
    for (const layer of layerList) {
      const key = layer.finish_override?.trim() || 'Unspecified';
      if (!byFinish.has(key)) byFinish.set(key, []);
      byFinish.get(key).push(layer);
    }
    return [...byFinish.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [layerList]);

  if (layerList.length === 0) {
    return <p className="p-3 text-xs text-[var(--graphite)]">No layers on this photo yet — finishes are set per layer in Surface properties once you have one.</p>;
  }

  return (
    <div className="p-2 flex flex-col gap-3 overflow-y-auto h-full">
      {groups.map(([finish, layers]) => (
        <section key={finish}>
          <h3 className="text-[10px] uppercase text-[var(--graphite)] mb-1.5">
            {finish} <span className="normal-case">({layers.length})</span>
          </h3>
          <ul className="flex flex-col gap-1">
            {layers.map((layer) => (
              <li key={layer.id}>
                <button
                  onClick={() => setActiveLayerId(layer.id)}
                  className={`w-full text-left text-sm px-2 py-1.5 rounded-[var(--radius-sm)] truncate ${
                    activeLayerId === layer.id ? 'bg-[var(--signal)]/10 border border-[var(--signal)]' : 'hover:bg-[var(--paper)] border border-transparent'
                  }`}
                >
                  {layer.name}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
