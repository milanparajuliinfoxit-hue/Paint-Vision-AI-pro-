import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../../../shared/ui/dialog';
import { Button } from '../../../shared/ui/button';
import ComparisonPreview from './ComparisonPreview';
import { applyPaintColor } from '../../../shared/lib/colorEngine';
import { exportsApi, assets as assetsApi } from '../../../shared/lib/api';
import { useToast } from '../../../shared/ui/toast';

const MODES = [
  { id: 'side-by-side', label: 'Side by side' },
  { id: 'slider', label: 'Slider' },
  { id: 'split', label: 'Split' },
  { id: 'fade', label: 'Fade' },
];

// Comparison + export (requirements doc, Section 8). Rendering the
// composite happens client-side on <canvas> — the backend just stores
// whatever blob is produced and marks the job ready, since there's no
// render-worker queue yet (PDF-with-branding is flagged as a follow-up,
// not silently downgraded to PNG).
export default function ExportPanel({
  open, onOpenChange, projectId, baseImage, baseImageData, width, height, layers, colorLookup, originalUrl,
}) {
  const [mode, setMode] = useState('side-by-side');
  const [format, setFormat] = useState('png');
  const [exporting, setExporting] = useState(false);
  const [paintedDataUrl, setPaintedDataUrl] = useState(null);
  const showToast = useToast();

  // Re-derives the full composite independently of LayerNode's own cached
  // canvases (which may not all be mounted) — same LAB blend, just composed
  // once here for export instead of once per on-screen layer.
  useEffect(() => {
    if (!open || !baseImage || !baseImageData || !width || !height) return;
    let cancelled = false;

    (async () => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(baseImage, 0, 0, width, height);

      const visibleLayers = [...layers].filter((l) => l.visible && l.mask_path).sort((a, b) => a.order_index - b.order_index);
      for (const layer of visibleLayers) {
        const maskImg = await loadImg(assetsApi.fileUrl(layer.mask_path));
        const maskCanvas = document.createElement('canvas');
        maskCanvas.width = width;
        maskCanvas.height = height;
        const maskCtx = maskCanvas.getContext('2d');
        maskCtx.drawImage(maskImg, 0, 0, width, height);
        const maskData = maskCtx.getImageData(0, 0, width, height);

        const rgb = colorLookup(layer.current_color_id) || { r: 47, g: 93, b: 138 };
        // Same parameters as LayerNode so the exported file matches what the
        // canvas shows — full pigment coverage + lightness re-anchoring.
        const painted = !!colorLookup(layer.current_color_id);
        const strength = painted ? 0.95 : 0.35;
        const recolored = applyPaintColor(baseImageData, maskData, rgb, strength, {
          transparentOutsideMask: true,
          lightnessBlend: painted ? 0.45 : 0,
        });

        const layerCanvas = document.createElement('canvas');
        layerCanvas.width = width;
        layerCanvas.height = height;
        layerCanvas.getContext('2d').putImageData(recolored, 0, 0);
        ctx.globalAlpha = Number(layer.opacity ?? 1);
        ctx.drawImage(layerCanvas, 0, 0);
        ctx.globalAlpha = 1;
      }

      if (!cancelled) setPaintedDataUrl(canvas.toDataURL('image/png'));
    })();

    return () => { cancelled = true; };
  }, [open, baseImage, baseImageData, width, height, layers, colorLookup]);

  async function handleExport() {
    if (!paintedDataUrl) return;
    setExporting(true);
    try {
      let blob;
      if (format === 'png') {
        blob = await (await fetch(paintedDataUrl)).blob();
      } else {
        blob = await composeSideBySide(originalUrl, paintedDataUrl);
      }
      const job = await exportsApi.create(projectId, { format, comparisonMode: mode }, blob);
      showToast(`Export ready — ${job.file_path.split(/[/\\]/).pop()}`);
      onOpenChange(false);
    } catch (err) {
      showToast(`Export failed: ${err.message}`, { variant: 'danger' });
    } finally {
      setExporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent open={open} className="max-w-lg">
        <DialogTitle>Compare & export</DialogTitle>
        <DialogDescription>
          Compare Original against Painted, then export a client-ready file. Editing stays available while this renders.
        </DialogDescription>

        <div className="flex gap-1 mb-3">
          {MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              className={`text-xs px-2.5 py-1 rounded-[var(--radius-sm)] ${mode === m.id ? 'bg-[var(--signal)] text-white' : 'border border-[var(--line)]'}`}
            >
              {m.label}
            </button>
          ))}
        </div>

        <ComparisonPreview mode={mode} beforeSrc={originalUrl} afterSrc={paintedDataUrl} beforeLabel="Original" afterLabel="Painted" />

        <div className="flex items-center gap-3 mt-4">
          <label className="text-sm font-medium">Format</label>
          <select value={format} onChange={(e) => setFormat(e.target.value)} className="rounded-[var(--radius-sm)] border border-[var(--line)] px-2 py-1 text-sm">
            <option value="png">PNG (painted only)</option>
            <option value="side-by-side-jpg">Side-by-side JPG</option>
            <option value="pdf" disabled>PDF with branding (coming soon)</option>
          </select>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Close</Button>
          <Button onClick={handleExport} disabled={exporting || !paintedDataUrl}>
            {exporting ? 'Rendering…' : 'Export'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

async function composeSideBySide(originalUrl, paintedDataUrl) {
  const [orig, painted] = await Promise.all([loadImg(originalUrl), loadImg(paintedDataUrl)]);
  const h = Math.max(orig.height, painted.height);
  const canvas = document.createElement('canvas');
  canvas.width = orig.width + painted.width;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(orig, 0, 0);
  ctx.drawImage(painted, orig.width, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
}

function loadImg(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
