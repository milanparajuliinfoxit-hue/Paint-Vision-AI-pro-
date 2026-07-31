import { useState } from 'react';
import { catalog } from '../lib/api';

export default function ImportModal({ onClose, onImported }) {
  const [file, setFile] = useState(null);
  const [report, setReport] = useState(null);
  const [duplicateStrategy, setDuplicateStrategy] = useState('update');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function runPreview() {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const result = await catalog.previewImport(file);
      setReport(result);
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  async function commit() {
    setBusy(true); setError(null);
    try {
      await catalog.commitImport({
        validRows: report.valid,
        fileName: file.name,
        duplicateStrategy,
      });
      onImported();
      onClose();
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  return (
    <div style={overlay}>
      <div style={modal}>
        <h2>Import color catalog</h2>
        <p style={{ color: 'var(--graphite)' }}>
          Upload the Excel file. Nothing is written to the catalog until you review the preview below and commit.
        </p>

        {!report && (
          <>
            <input type="file" accept=".xlsx,.xls" onChange={(e) => setFile(e.target.files[0])} />
            <div style={{ marginTop: 16 }}>
              <button disabled={!file || busy} onClick={runPreview} style={primaryBtn}>
                {busy ? 'Validating…' : 'Preview import'}
              </button>
            </div>
          </>
        )}

        {report && (
          <>
            <div style={summaryRow}>
              <SummaryStat label="New" value={report.summary.willCreate} color="var(--success)" />
              <SummaryStat label="Updates" value={report.summary.willUpdate} color="var(--signal)" />
              <SummaryStat label="Errors" value={report.summary.errorCount} color="var(--danger)" />
            </div>

            {report.errors.length > 0 && (
              <div style={errorBox}>
                <strong>Rows with errors (will be skipped):</strong>
                <ul style={{ maxHeight: 140, overflowY: 'auto', margin: '8px 0 0', paddingLeft: 18 }}>
                  {report.errors.map((e) => (
                    <li key={e.row}>Row {e.row}: {e.issues.join('; ')}</li>
                  ))}
                </ul>
              </div>
            )}

            <div style={{ margin: '16px 0' }}>
              <label style={{ display: 'block', marginBottom: 6, fontWeight: 500 }}>
                For colorCodes that already exist:
              </label>
              <select value={duplicateStrategy} onChange={(e) => setDuplicateStrategy(e.target.value)}>
                <option value="update">Update existing record</option>
                <option value="skip">Skip (keep existing)</option>
                <option value="create_new">Create as new record</option>
              </select>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={commit} disabled={busy} style={primaryBtn}>
                {busy ? 'Importing…' : `Commit import`}
              </button>
              <button onClick={() => setReport(null)} style={secondaryBtn}>Back</button>
            </div>
          </>
        )}

        {error && <p style={{ color: 'var(--danger)', marginTop: 12 }}>{error}</p>}

        <button onClick={onClose} style={closeBtn} aria-label="Close">✕</button>
      </div>
    </div>
  );
}

function SummaryStat({ label, value, color }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 28, fontFamily: 'var(--font-display)', color }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--graphite)' }}>{label}</div>
    </div>
  );
}

const overlay = {
  position: 'fixed', inset: 0, background: 'rgba(23,24,28,0.4)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
};
const modal = {
  background: 'var(--paper-raised)', borderRadius: 'var(--radius-md)', padding: 28,
  width: 520, maxHeight: '85vh', overflowY: 'auto', position: 'relative', boxShadow: 'var(--shadow-card)',
};
const summaryRow = { display: 'flex', gap: 24, margin: '16px 0' };
const errorBox = {
  background: '#fbeeeb', border: '1px solid var(--danger)', borderRadius: 'var(--radius-sm)',
  padding: 12, fontSize: 13,
};
const primaryBtn = {
  background: 'var(--signal)', color: 'white', border: 'none', borderRadius: 'var(--radius-sm)',
  padding: '10px 18px', fontWeight: 500,
};
const secondaryBtn = {
  background: 'transparent', color: 'var(--ink)', border: '1px solid var(--line)',
  borderRadius: 'var(--radius-sm)', padding: '10px 18px', fontWeight: 500,
};
const closeBtn = {
  position: 'absolute', top: 16, right: 16, background: 'none', border: 'none', fontSize: 16, color: 'var(--graphite)',
};
