import { useMemo, useState } from 'react';
import { useCatalogList } from '../../catalog/useCatalogList';
import { useFavorites } from '../../catalog/useFavorites';
import { useCollections } from '../../catalog/useCollections';
import { useApplyColor } from '../hooks/useApplyColor';
import { useVisualizerStore } from '../store/visualizerStore';
import { ConfirmDialog, InputDialog } from '../../../shared/ui/confirmDialog';
import ColorGrid from './ColorGrid';

export default function CollectionsTab({ projectId, assetId }) {
  const { data: catalogData } = useCatalogList({ pageSize: 2000 });
  const { isFavorite, toggleFavorite, markRecentlyUsed } = useFavorites();
  const { collections, createCollection, renameCollection, deleteCollection, togglePaintInCollection } = useCollections();
  const { pickColor, hoverColor } = useApplyColor(projectId, assetId);
  const pendingColorId = useVisualizerStore((s) => s.pendingColorId);

  const [activeId, setActiveId] = useState(null);
  const [managing, setManaging] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const active = collections.find((c) => c.id === activeId) || null;
  const allRows = catalogData?.rows || [];
  const rows = useMemo(() => {
    if (!active) return [];
    const ids = new Set(active.paintIds);
    return managing ? allRows : allRows.filter((p) => ids.has(p.id));
  }, [active, allRows, managing]);

  function pick(paint) {
    if (managing) {
      togglePaintInCollection(active.id, paint.id);
      return;
    }
    markRecentlyUsed({ id: paint.id, color_name: paint.color_name, color_code: paint.color_code, hex_value: paint.hex_value });
    pickColor(paint);
  }

  if (!active) {
    return (
      <div className="p-2 flex flex-col gap-1">
        <button onClick={() => setCreating(true)} className="text-xs text-left px-2 py-1.5 rounded-[var(--radius-sm)] bg-[var(--signal)] text-white font-medium mb-1">
          + New collection
        </button>
        {collections.length === 0 && (
          <p className="text-xs text-[var(--graphite)] px-2 py-2">
            Group catalog colors into named sets — e.g. a shortlist to show a client — and reuse them across projects.
          </p>
        )}
        {collections.map((c) => (
          <button
            key={c.id}
            onClick={() => setActiveId(c.id)}
            className="flex items-center justify-between text-sm px-2 py-1.5 rounded-[var(--radius-sm)] hover:bg-[var(--paper)] text-left"
          >
            <span className="truncate">{c.name}</span>
            <span className="text-[10px] text-[var(--graphite)] shrink-0 ml-2">{c.paintIds.length}</span>
          </button>
        ))}

        <InputDialog
          open={creating}
          onOpenChange={setCreating}
          title="New collection"
          label="Name"
          placeholder='e.g. "Warm neutrals"'
          confirmLabel="Create"
          onConfirm={(name) => setActiveId(createCollection(name))}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1.5 p-2 border-b border-[var(--line)]">
        <button onClick={() => setActiveId(null)} aria-label="Back to collections" className="text-xs px-1.5 py-1 rounded-[var(--radius-sm)] hover:bg-[var(--paper)]">
          ←
        </button>
        <span className="text-sm font-medium flex-1 truncate">{active.name}</span>
        <button onClick={() => setRenaming(true)} className="text-[11px] text-[var(--graphite)] hover:text-[var(--ink)]">
          Rename
        </button>
        <button onClick={() => setConfirmingDelete(true)} className="text-[11px] text-[var(--danger)]">
          Delete
        </button>

        <InputDialog
          open={renaming}
          onOpenChange={setRenaming}
          title="Rename collection"
          label="Name"
          defaultValue={active.name}
          confirmLabel="Save"
          onConfirm={(name) => renameCollection(active.id, name)}
        />
        <ConfirmDialog
          open={confirmingDelete}
          onOpenChange={setConfirmingDelete}
          title={`Delete "${active.name}"?`}
          confirmLabel="Delete"
          destructive
          onConfirm={() => { deleteCollection(active.id); setActiveId(null); }}
        />
      </div>
      <div className="flex items-center justify-between px-2 pt-2">
        <span className="text-[10px] uppercase text-[var(--graphite)]">{managing ? 'Add colors' : `${active.paintIds.length} color(s)`}</span>
        <button onClick={() => setManaging((m) => !m)} className="text-[11px] text-[var(--signal)]">
          {managing ? 'Done' : 'Edit colors'}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        <ColorGrid
          rows={rows}
          pendingColorId={pendingColorId}
          isSelected={managing ? (paint) => active.paintIds.includes(paint.id) : undefined}
          isFavorite={isFavorite}
          onToggleFavorite={managing ? undefined : toggleFavorite}
          onPick={pick}
          onHover={managing ? undefined : hoverColor}
          emptyMessage={managing ? 'No colors in the catalog.' : 'Empty — tap "Edit colors" to add some.'}
        />
      </div>
    </div>
  );
}
