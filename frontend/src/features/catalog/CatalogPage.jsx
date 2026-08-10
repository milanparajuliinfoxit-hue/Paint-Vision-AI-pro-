import { useEffect, useRef, useState } from 'react';
import { catalog } from '../../shared/lib/api';
import { rgbToLab, rgbToHex, hexToRgb, labDistance } from '../../shared/lib/colorEngine';
import ImportModal from './ImportModal';
import PaintCard from './PaintCard';
import { useFavorites } from './useFavorites';

const PRODUCT_LINES = ['tenprotect', 'brightshine', 'colorfuleco', 'jotashield', 'majestic', 'sevenprotect', 'surprised'];
const PAGE_SIZE = 24;
const HEX_PATTERN = /^#?[0-9a-f]{6}$/i;

export default function CatalogPage({ onColorFocus }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [productLine, setProductLine] = useState('');
  const [hexQuery, setHexQuery] = useState('');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [showImport, setShowImport] = useState(false);
  const [editing, setEditing] = useState(null); // paint object or 'new'
  const [loading, setLoading] = useState(false);

  const { isFavorite, toggleFavorite, recentPaints, markRecentlyUsed } = useFavorites();
  const gridRef = useRef(null);
  const cardRefs = useRef([]);

  // Hex-proximity ("colors like this one") and the favorites filter aren't
  // things the backend can search/filter by — pull a large batch and do it
  // client-side rather than adding a bespoke endpoint for a browse-time
  // convenience (requirements doc, Section 6.1).
  async function load() {
    setLoading(true);
    try {
      const clientSideMode = favoritesOnly || HEX_PATTERN.test(hexQuery);
      if (clientSideMode) {
        const result = await catalog.list({ search, productLine, page: 1, pageSize: 1000 });
        let list = result.rows;
        if (favoritesOnly) list = list.filter((p) => isFavorite(p.id));
        if (HEX_PATTERN.test(hexQuery)) {
          const targetRgb = hexToRgb(hexQuery);
          const targetLab = rgbToLab(targetRgb.r, targetRgb.g, targetRgb.b);
          list = [...list].sort(
            (a, b) =>
              labDistance(targetLab, rgbToLab(a.r_value, a.g_value, a.b_value)) -
              labDistance(targetLab, rgbToLab(b.r_value, b.g_value, b.b_value))
          );
        }
        setTotal(list.length);
        setRows(list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE));
      } else {
        const result = await catalog.list({ search, productLine, page, pageSize: PAGE_SIZE });
        setRows(result.rows);
        setTotal(result.total);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [search, productLine, page, hexQuery, favoritesOnly]); // eslint-disable-line

  function pickColor(paint) {
    onColorFocus(paint.hex_value);
    markRecentlyUsed(paint);
  }

  // Arrow-key grid navigation (requirements doc, Section 12: "arrow through
  // cards, Enter to apply") — column count is measured from the actual
  // resolved grid-template-columns rather than assumed, since the
  // auto-fill/minmax layout's column count changes with viewport width.
  function handleGridKeyDown(e, index) {
    const cols = gridRef.current
      ? getComputedStyle(gridRef.current).gridTemplateColumns.split(' ').length
      : 1;
    let next = null;
    if (e.key === 'ArrowRight') next = index + 1;
    else if (e.key === 'ArrowLeft') next = index - 1;
    else if (e.key === 'ArrowDown') next = index + cols;
    else if (e.key === 'ArrowUp') next = index - cols;
    if (next === null) return;
    if (next >= 0 && next < cardRefs.current.length) {
      e.preventDefault();
      cardRefs.current[next]?.focus();
    }
  }

  return (
    <div className="p-8 max-w-6xl">
      <header className="flex justify-between items-end mb-6">
        <div>
          <h1>Color Catalog</h1>
          <p className="text-[var(--graphite)] mt-1">{total} colors</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowImport(true)} style={secondaryBtn}>Import Excel</button>
          <a href={catalog.exportUrl()} style={{ ...secondaryBtn, textDecoration: 'none', display: 'inline-block' }}>Export</a>
          <button onClick={() => setEditing('new')} style={primaryBtn}>+ Add color</button>
        </div>
      </header>

      {recentPaints.length > 0 && (
        <section className="mb-5">
          <h2 className="text-xs uppercase text-[var(--graphite)] mb-2">Recently used</h2>
          <div className="flex gap-2">
            {recentPaints.map((p) => (
              <button
                key={p.id}
                title={`${p.color_name} (${p.color_code})`}
                onClick={() => pickColor(p)}
                className="w-9 h-9 rounded-full border border-[var(--line)]"
                style={{ background: p.hex_value }}
              />
            ))}
          </div>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-3 mb-5">
        <input
          placeholder="Search by name or code…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          style={input}
        />
        <select value={productLine} onChange={(e) => { setProductLine(e.target.value); setPage(1); }} style={input}>
          <option value="">All product lines</option>
          {PRODUCT_LINES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <input
          placeholder="Similar to hex, e.g. #7a8b6f"
          value={hexQuery}
          onChange={(e) => { setHexQuery(e.target.value); setPage(1); }}
          style={{ ...input, width: 180 }}
        />
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={favoritesOnly} onChange={(e) => { setFavoritesOnly(e.target.checked); setPage(1); }} />
          Favorites only
        </label>
      </div>

      {loading && <p className="text-[var(--graphite)]">Loading…</p>}

      <div ref={gridRef} role="grid" aria-label="Paint colors" className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
        {rows.map((p, i) => (
          <div key={p.id} className="relative group">
            <PaintCard
              ref={(el) => { cardRefs.current[i] = el; }}
              paint={p}
              isFavorite={isFavorite(p.id)}
              onSelect={pickColor}
              onToggleFavorite={toggleFavorite}
              onKeyDown={(e) => handleGridKeyDown(e, i)}
            />
            <div className="absolute inset-x-2 bottom-2 hidden group-hover:flex gap-2 bg-[var(--paper-raised)]/95 rounded-[var(--radius-sm)] px-1.5 py-1 text-xs">
              <button onClick={() => setEditing(p)} className="text-[var(--signal)]">Edit</button>
              <button
                onClick={async () => { if (confirm('Delete this color?')) { await catalog.remove(p.id); load(); } }}
                className="text-[var(--danger)]"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {!loading && rows.length === 0 && (
        <p className="text-[var(--graphite)] mt-6">No colors match this search.</p>
      )}

      <div className="flex gap-2 mt-5 items-center">
        <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} style={secondaryBtn}>Prev</button>
        <span className="text-[var(--graphite)] text-sm">Page {page}</span>
        <button disabled={page * PAGE_SIZE >= total} onClick={() => setPage((p) => p + 1)} style={secondaryBtn}>Next</button>
      </div>

      {showImport && <ImportModal onClose={() => setShowImport(false)} onImported={load} />}
      {editing && <PaintEditor paint={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
}

function PaintEditor({ paint, onClose, onSaved }) {
  const [form, setForm] = useState(() => paint || {
    color_code: '', color_name: '', r_value: 255, g_value: 255, b_value: 255,
    ...Object.fromEntries(PRODUCT_LINES.map((k) => [k, false])),
  });
  const [error, setError] = useState(null);
  const hex = rgbToHex(form.r_value, form.g_value, form.b_value);

  async function save() {
    try {
      if (paint) await catalog.update(paint.id, form);
      else await catalog.create(form);
      onSaved();
      onClose();
    } catch (e) { setError(e.message); }
  }

  return (
    <div style={overlay}>
      <div style={modal}>
        <h2>{paint ? 'Edit color' : 'Add color'}</h2>
        <div style={{ display: 'flex', gap: 16, marginTop: 16 }}>
          <div style={{ width: 64, height: 64, borderRadius: 8, background: hex, border: '1px solid var(--line)', flexShrink: 0 }} />
          <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="Color code">
              <input value={form.color_code} onChange={(e) => setForm({ ...form, color_code: e.target.value })} style={input} />
            </Field>
            <Field label="Color name">
              <input value={form.color_name} onChange={(e) => setForm({ ...form, color_name: e.target.value })} style={input} />
            </Field>
            <Field label="R"><input type="number" min="0" max="255" value={form.r_value} onChange={(e) => setForm({ ...form, r_value: +e.target.value })} style={input} /></Field>
            <Field label="G"><input type="number" min="0" max="255" value={form.g_value} onChange={(e) => setForm({ ...form, g_value: +e.target.value })} style={input} /></Field>
            <Field label="B"><input type="number" min="0" max="255" value={form.b_value} onChange={(e) => setForm({ ...form, b_value: +e.target.value })} style={input} /></Field>
          </div>
        </div>

        <div style={{ marginTop: 16 }}>
          <div style={{ fontWeight: 500, marginBottom: 6 }}>Product lines</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {PRODUCT_LINES.map((k) => (
              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={!!form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.checked })} />
                {k}
              </label>
            ))}
          </div>
        </div>

        {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

        <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
          <button onClick={save} style={primaryBtn}>Save</button>
          <button onClick={onClose} style={secondaryBtn}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'block', fontSize: 12, color: 'var(--graphite)' }}>
      {label}
      <div style={{ marginTop: 2 }}>{children}</div>
    </label>
  );
}

const input = { padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)', fontFamily: 'inherit' };
const primaryBtn = { background: 'var(--signal)', color: 'white', border: 'none', borderRadius: 'var(--radius-sm)', padding: '9px 16px', fontWeight: 500 };
const secondaryBtn = { background: 'var(--paper-raised)', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)', padding: '9px 16px', fontWeight: 500 };
const overlay = { position: 'fixed', inset: 0, background: 'rgba(23,24,28,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 };
const modal = { background: 'var(--paper-raised)', borderRadius: 'var(--radius-md)', padding: 28, width: 520, boxShadow: 'var(--shadow-card)' };
