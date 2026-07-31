import { useEffect, useState } from 'react';
import { catalog } from '../lib/api';
import ColorSwatch from '../components/ColorSwatch';
import ImportModal from '../components/ImportModal';

const PRODUCT_LINES = ['tenprotect', 'brightshine', 'colorfuleco', 'jotashield', 'majestic', 'sevenprotect', 'surprised'];

export default function CatalogPage({ onColorFocus }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [productLine, setProductLine] = useState('');
  const [page, setPage] = useState(1);
  const [showImport, setShowImport] = useState(false);
  const [editing, setEditing] = useState(null); // paint object or 'new'
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const result = await catalog.list({ search, productLine, page, pageSize: 20 });
      setRows(result.rows);
      setTotal(result.total);
    } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, [search, productLine, page]); // eslint-disable-line

  return (
    <div style={{ padding: 32, maxWidth: 1100 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 24 }}>
        <div>
          <h1>Color Catalog</h1>
          <p style={{ color: 'var(--graphite)', margin: '4px 0 0' }}>{total} colors</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setShowImport(true)} style={secondaryBtn}>Import Excel</button>
          <a href={catalog.exportUrl()} style={{ ...secondaryBtn, textDecoration: 'none', display: 'inline-block' }}>Export</a>
          <button onClick={() => setEditing('new')} style={primaryBtn}>+ Add color</button>
        </div>
      </header>

      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
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
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--graphite)', fontSize: 12, textTransform: 'uppercase' }}>
            <th style={th}></th>
            <th style={th}>Code</th>
            <th style={th}>Name</th>
            <th style={th}>Hex</th>
            <th style={th}>Product lines</th>
            <th style={th}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id} style={{ borderTop: '1px solid var(--line)' }}>
              <td style={td}>
                <ColorSwatch hex={p.hex_value} onClick={() => onColorFocus(p.hex_value)} />
              </td>
              <td style={{ ...td }} className="color-code">{p.color_code}</td>
              <td style={td}>{p.color_name}</td>
              <td style={td} className="color-code">{p.hex_value}</td>
              <td style={td}>
                {PRODUCT_LINES.filter((k) => p[k]).join(', ') || '—'}
              </td>
              <td style={td}>
                <button onClick={() => setEditing(p)} style={linkBtn}>Edit</button>
                <button
                  onClick={async () => { if (confirm('Delete this color?')) { await catalog.remove(p.id); load(); } }}
                  style={{ ...linkBtn, color: 'var(--danger)' }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {loading && <p style={{ color: 'var(--graphite)' }}>Loading…</p>}

      <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' }}>
        <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} style={secondaryBtn}>Prev</button>
        <span style={{ color: 'var(--graphite)' }}>Page {page}</span>
        <button disabled={page * 20 >= total} onClick={() => setPage((p) => p + 1)} style={secondaryBtn}>Next</button>
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

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}

const th = { padding: '8px 10px' };
const td = { padding: '10px', verticalAlign: 'middle' };
const input = { padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)', fontFamily: 'inherit' };
const primaryBtn = { background: 'var(--signal)', color: 'white', border: 'none', borderRadius: 'var(--radius-sm)', padding: '9px 16px', fontWeight: 500 };
const secondaryBtn = { background: 'var(--paper-raised)', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)', padding: '9px 16px', fontWeight: 500 };
const linkBtn = { background: 'none', border: 'none', color: 'var(--signal)', marginRight: 10, padding: 0, fontSize: 13 };
const overlay = { position: 'fixed', inset: 0, background: 'rgba(23,24,28,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 };
const modal = { background: 'var(--paper-raised)', borderRadius: 'var(--radius-md)', padding: 28, width: 520, boxShadow: 'var(--shadow-card)' };
