import { useState } from 'react';
import { useHistoryList } from '../hooks/useHistoryEntries';

const ACTION_LABEL = {
  'color-applied': 'Color applied',
  'opacity-changed': 'Opacity changed',
  'visibility-changed': 'Visibility toggled',
  'lock-changed': 'Lock toggled',
  'order-changed': 'Reordered',
  'name-changed': 'Layer renamed',
  'finish-changed': 'Finish changed',
  'mask-created': 'Painted new area',
  'mask-edited': 'Edited paint',
  'layer-deleted': 'Deleted paint',
  'paint-cleared': 'Cleared all paint',
};

// A project can accumulate hundreds of entries over its lifetime — render
// only the most recent PAGE_SIZE by default with a "Show earlier" reveal,
// instead of mounting hundreds of rows up front.
const PAGE_SIZE = 40;

// Scrubbable command log — click an entry to jump the whole session to that
// point (undo/redo replay under the hood), not a full-state snapshot list
// (requirements doc, Section 5.1/5.3). Represents user actions (paint,
// erase, clear, color changes), not raw layer ids or API calls.
export default function HistoryTab({ projectId, undoPointer, onJumpTo }) {
  const { data: entries = [] } = useHistoryList(projectId);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  if (entries.length === 0) {
    return <p className="p-3 text-xs text-[var(--graphite)]">No history yet — actions you take will appear here.</p>;
  }

  // Undo-stack indices are assigned in chronological order regardless of
  // which page is currently rendered, so pagination never shifts an
  // entry's jump target. Must mirror useHistoryCommand.js's hydrateHistory
  // filter exactly (recognized action type AND not superseded) — that's the
  // same undoStack this jumps into, so a mismatched filter here would either
  // jump to the wrong entry or let a click resurrect an abandoned redo
  // branch through a path the undo/redo buttons already block. Superseded
  // entries stay visible (real history, not hidden) but are not jumpable —
  // same disabled styling already used for unrecognized action types.
  let jumpIndex = -1;
  const indexed = entries.map((entry) => {
    const jumpable = !!ACTION_LABEL[entry.action] && !entry.superseded_at;
    if (jumpable) jumpIndex += 1;
    return { entry, jumpable, index: jumpIndex };
  });

  const visible = indexed.slice(-visibleCount);
  const hiddenCount = indexed.length - visible.length;

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {hiddenCount > 0 && (
        <button
          onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
          className="text-[11px] text-[var(--signal)] hover:underline px-3 py-2 text-left"
        >
          Show {Math.min(hiddenCount, PAGE_SIZE)} earlier entr{Math.min(hiddenCount, PAGE_SIZE) === 1 ? 'y' : 'ies'}…
        </button>
      )}
      <ul className="p-2 pt-0 flex flex-col gap-0.5">
        {visible.map(({ entry, jumpable, index }) => {
          const isCurrent = jumpable && index === undoPointer;
          return (
            <li key={entry.id}>
              <button
                disabled={!jumpable}
                onClick={() => jumpable && onJumpTo(index)}
                className={`w-full text-left px-2 py-1.5 rounded-[var(--radius-sm)] text-xs flex items-center justify-between ${
                  isCurrent ? 'bg-[var(--signal)]/10 text-[var(--signal)]' : jumpable ? 'hover:bg-[var(--paper)]' : 'text-[var(--graphite)]'
                }`}
              >
                <span>{ACTION_LABEL[entry.action] || entry.action}</span>
                <span className="text-[10px] text-[var(--graphite)]">
                  {new Date(entry.created_at).toLocaleTimeString()}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
