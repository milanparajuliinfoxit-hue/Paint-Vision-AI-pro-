import { useRef, useState, useEffect } from 'react';
import { visualizer, catalog } from '../lib/api';
import { extractContextColors, suggestColors } from '../lib/colorSuggest';
import ImageCanvas from '../components/ImageCanvas';
import ColorSwatch from '../components/ColorSwatch';
import StepIndicator from '../components/StepIndicator';

export default function VisualizerPage({ onColorFocus }) {
  const canvasRef = useRef(null);
  const [job, setJob] = useState(null);
  const [imageUrl, setImageUrl] = useState(null);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [catalogRows, setCatalogRows] = useState([]);
  const [selectedPaint, setSelectedPaint] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [brushSize, setBrushSize] = useState(50);

  useEffect(() => {
    catalog.list({ pageSize: 500 }).then((r) => setCatalogRows(r.rows)).catch(() => {});
  }, []);

  async function handleUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const result = await visualizer.upload(file);
      setJob(result);
      setImageUrl(URL.createObjectURL(file)); // show immediately, client-side, no round trip needed to view it
      setStep(1);
    } catch (err) { setError(err.message); }
    setBusy(false);
  }

  async function handleCleanup() {
    setBusy(true); setError(null);
    try {
      // Server does no image processing itself — it just forwards to the
      // hosted AI API and hands back the cleaned file reference.
      const updated = await visualizer.requestCleanup(job.jobId);
      setJob((j) => ({ ...j, ...updated }));
      setImageUrl(visualizer.fileUrl(updated.cleaned_path));
      setStep(2);
    } catch (err) {
      setError(`Cleanup failed: ${err.message}. You can continue with the original photo instead.`);
    }
    setBusy(false);
  }

  function skipCleanup() {
    setStep(2);
  }

  async function handleGetSuggestions() {
    const displayCanvas = canvasRef.current;
    // Reach into the canvas via the exposed helpers only — page never touches
    // pixel buffers directly, that stays inside colorEngine/ImageCanvas.
    const dims = displayCanvas.getDims();
    if (!dims.width) return;

    // Use the live canvas + an all-zero mask copy is unnecessary here; we
    // just need *some* imageData + maskData shape for extractContextColors.
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = dims.width; tempCanvas.height = dims.height;
    const ctx = tempCanvas.getContext('2d');
    // Grab pixels straight from the visible canvas element rendered by ImageCanvas.
    const el = document.querySelector('.viz-canvas canvas');
    if (el) ctx.drawImage(el, 0, 0);
    const imageData = ctx.getImageData(0, 0, dims.width, dims.height);
    const emptyMask = ctx.createImageData(dims.width, dims.height); // alpha 0 everywhere = "no selection yet"

    const context = extractContextColors(imageData, emptyMask);
    const results = suggestColors(context, catalogRows, 5);
    setSuggestions(results);
  }

  function pickPaint(paint) {
    setSelectedPaint(paint);
    onColorFocus(paint.hex_value);
  }

  function applyColor() {
    if (!selectedPaint) return;
    const rgb = { r: selectedPaint.r_value, g: selectedPaint.g_value, b: selectedPaint.b_value };
    canvasRef.current.applyColor(rgb, 0.85);
    setStep(3);
  }

  function clearSelection() {
    canvasRef.current.clearMask();
  }

  async function saveResult() {
    setBusy(true);
    try {
      const blob = await canvasRef.current.exportPng();
      await visualizer.saveResult(job.jobId, blob, {
        paintId: selectedPaint?.id,
        surfaceLabel: 'user-selected surface',
      });
      alert('Saved to project.');
    } catch (err) { setError(err.message); }
    setBusy(false);
  }

  return (
    <div style={{ padding: 32, maxWidth: 1200 }}>
      <h1>Visualize</h1>
      <p style={{ color: 'var(--graphite)', marginTop: 4 }}>
        Upload a client photo, clean it up, then try catalog colors on any surface.
      </p>

      <div style={{ marginTop: 24 }}>
        <StepIndicator current={step} />
      </div>

      {!job && (
        <div style={uploadBox}>
          <input type="file" accept="image/*" onChange={handleUpload} disabled={busy} />
          <p style={{ color: 'var(--graphite)', fontSize: 13, marginTop: 8 }}>
            Any common photo format. Large images are downscaled client-side before anything is sent.
          </p>
        </div>
      )}

      {job && (
        <div style={{ display: 'flex', gap: 32, marginTop: 24, alignItems: 'flex-start' }}>
          <div className="viz-canvas">
            <ImageCanvas ref={canvasRef} imageUrl={imageUrl} brushSize={brushSize} />
            {step >= 2 && (
              <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
                <label style={{ fontSize: 12, color: 'var(--graphite)' }}>Brush size</label>
                <input type="range" min="10" max="150" value={brushSize} onChange={(e) => setBrushSize(+e.target.value)} />
                <button onClick={clearSelection} style={secondaryBtn}>Clear selection</button>
              </div>
            )}
          </div>

          <div style={{ width: 320 }}>
            {step === 1 && (
              <Panel title="Clean up the photo">
                <p style={{ color: 'var(--graphite)', fontSize: 13 }}>
                  Remove construction debris, materials, and neighboring objects automatically before you start painting.
                </p>
                <button onClick={handleCleanup} disabled={busy} style={primaryBtn}>
                  {busy ? 'Cleaning up…' : 'Run AI cleanup'}
                </button>
                <button onClick={skipCleanup} style={{ ...secondaryBtn, marginTop: 8 }}>Skip — use original photo</button>
              </Panel>
            )}

            {step >= 2 && (
              <Panel title="Select a surface">
                <p style={{ color: 'var(--graphite)', fontSize: 13 }}>
                  Brush over the area you want to paint (e.g. the front wall), then choose a color.
                </p>
              </Panel>
            )}

            {step >= 2 && (
              <Panel title="Catalog colors">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8, marginBottom: 12 }}>
                  {catalogRows.slice(0, 30).map((p) => (
                    <ColorSwatch
                      key={p.id}
                      hex={p.hex_value}
                      selected={selectedPaint?.id === p.id}
                      onClick={() => pickPaint(p)}
                    />
                  ))}
                </div>
                {selectedPaint && (
                  <p style={{ fontSize: 13 }}>
                    <strong>{selectedPaint.color_name}</strong> <span className="color-code">{selectedPaint.color_code}</span>
                  </p>
                )}
                <button onClick={applyColor} disabled={!selectedPaint} style={primaryBtn}>Apply color</button>
              </Panel>
            )}

            {step >= 2 && (
              <Panel title="AI color suggestions">
                <button onClick={handleGetSuggestions} style={secondaryBtn}>Suggest colors from photo</button>
                {suggestions.length > 0 && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                    {suggestions.map((p) => (
                      <div key={p.id} style={{ textAlign: 'center' }}>
                        <ColorSwatch hex={p.hex_value} onClick={() => pickPaint(p)} />
                        <div style={{ fontSize: 10, marginTop: 4, maxWidth: 40 }}>{p.color_name}</div>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
            )}

            {step === 3 && (
              <Panel title="Save this look">
                <button onClick={saveResult} disabled={busy} style={primaryBtn}>
                  {busy ? 'Saving…' : 'Save to project'}
                </button>
              </Panel>
            )}
          </div>
        </div>
      )}

      {error && <p style={{ color: 'var(--danger)', marginTop: 16 }}>{error}</p>}
    </div>
  );
}

function Panel({ title, children }) {
  return (
    <div style={{ background: 'var(--paper-raised)', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)', padding: 16, marginBottom: 16 }}>
      <h3 style={{ fontSize: 14, marginBottom: 10 }}>{title}</h3>
      {children}
    </div>
  );
}

const uploadBox = {
  marginTop: 24, padding: 40, border: '2px dashed var(--line)', borderRadius: 'var(--radius-md)',
  textAlign: 'center', background: 'var(--paper-raised)',
};
const primaryBtn = { background: 'var(--signal)', color: 'white', border: 'none', borderRadius: 'var(--radius-sm)', padding: '9px 16px', fontWeight: 500, width: '100%' };
const secondaryBtn = { background: 'var(--paper-raised)', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)', padding: '9px 16px', fontWeight: 500 };
