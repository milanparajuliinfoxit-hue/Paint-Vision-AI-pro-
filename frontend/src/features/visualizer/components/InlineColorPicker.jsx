import { useEffect, useMemo, useRef, useState } from 'react';
import { useCatalogList } from '../../catalog/useCatalogList';
import ColorGrid from '../panels/ColorGrid';

// Compact catalog color picker for contexts that aren't the full Catalog
// tab (e.g. one row per detected-surface group) — a swatch button that
// opens a small searchable popover on click. Selecting a paint always
// comes from the same catalog data every other picker in the app uses
// (useCatalogList) — never a second color source.
export default function InlineColorPicker({ value, onChange, placeholder = 'Choose color' }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const { data } = useCatalogList({ pageSize: 2000 });
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onDocClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const rows = useMemo(() => {
    const list = data?.rows || [];
    if (!query.trim()) return list.slice(0, 40);
    const q = query.trim().toLowerCase();
    return list.filter((p) => p.color_name.toLowerCase().includes(q) || p.color_code.toLowerCase().includes(q)).slice(0, 60);
  }, [data, query]);

  function pick(paint) {
    onChange(paint);
    setOpen(false);
    setQuery('');
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--paper)] px-2 py-1 text-[11px] hover:border-[var(--signal)]"
      >
        <span
          className="h-4 w-4 shrink-0 rounded-full border border-black/10"
          style={{ background: value?.hex_value || 'repeating-linear-gradient(45deg, #ccc 0 4px, #fff 4px 8px)' }}
        />
        <span className="max-w-[100px] truncate">{value?.color_name || placeholder}</span>
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-1 w-64 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--paper)] shadow-lg">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or code…"
            aria-label="Search catalog colors"
            className="w-full border-b border-[var(--line)] px-2 py-1.5 text-xs outline-none"
          />
          <div className="max-h-60 overflow-y-auto">
            <ColorGrid rows={rows} isSelected={(p) => p.id === value?.id} onPick={pick} emptyMessage="No colors match." />
          </div>
        </div>
      )}
    </div>
  );
}
