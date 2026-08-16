import { useEffect, useRef } from 'react';
import { useLayersList, useUpdateLayer } from '../hooks/useLayers';
import { useHistoryCommand } from '../hooks/useHistoryCommand';
import { useVisualizerStore } from '../store/visualizerStore';
import { Slider } from '../../../shared/ui/slider';

// Tool options (brush/eraser/magic-wand) and the active layer's own
// properties (name, opacity, finish). Color browsing lives in the Colors
// tab; pendingColorId is global store state, so picking a color there while
// a layer is selected here still applies it immediately.
export default function AdjustmentsTab({ projectId, assetId }) {
  const activeTool = useVisualizerStore((s) => s.activeTool);
  const brushMode = useVisualizerStore((s) => s.brushMode);
  const setBrushMode = useVisualizerStore((s) => s.setBrushMode);
  const maskRefineMode = useVisualizerStore((s) => s.maskRefineMode);
  const setMaskRefineMode = useVisualizerStore((s) => s.setMaskRefineMode);
  const brushSize = useVisualizerStore((s) => s.brushSize);
  const setBrushSize = useVisualizerStore((s) => s.setBrushSize);
  const magicWandTolerance = useVisualizerStore((s) => s.magicWandTolerance);
  const setMagicWandTolerance = useVisualizerStore((s) => s.setMagicWandTolerance);
  const magicWandFeather = useVisualizerStore((s) => s.magicWandFeather);
  const setMagicWandFeather = useVisualizerStore((s) => s.setMagicWandFeather);
  const magicWandDebugEnabled = useVisualizerStore((s) => s.magicWandDebugEnabled);
  const setMagicWandDebugEnabled = useVisualizerStore((s) => s.setMagicWandDebugEnabled);
  const magicWandDebug = useVisualizerStore((s) => s.magicWandDebug);
  const surfaceAware = useVisualizerStore((s) => s.surfaceAware);
  const setSurfaceAware = useVisualizerStore((s) => s.setSurfaceAware);
  const surfaceTolerance = useVisualizerStore((s) => s.surfaceTolerance);
  const setSurfaceTolerance = useVisualizerStore((s) => s.setSurfaceTolerance);
  const aiSurfaceLock = useVisualizerStore((s) => s.aiSurfaceLock);
  const setAiSurfaceLock = useVisualizerStore((s) => s.setAiSurfaceLock);
  const activeLayerId = useVisualizerStore((s) => s.activeLayerId);

  const { data: layerList = [] } = useLayersList(assetId);
  const updateLayer = useUpdateLayer(assetId);
  const { commit } = useHistoryCommand(projectId, assetId);
  const activeLayer = layerList.find((l) => l.id === activeLayerId);

  // The opacity slider fires onValueChange continuously while dragging —
  // committing one undo step per pixel of drag would make undo useless.
  // Track the value from *before* the current drag/gesture started, and
  // only record one undo step when the gesture finishes.
  const opacityBeforeDrag = useRef(activeLayer?.opacity);
  useEffect(() => { opacityBeforeDrag.current = activeLayer?.opacity; }, [activeLayerId]);

  return (
    <div className="p-3 flex flex-col gap-4">
      {activeTool === 'brush' && (
        <section>
          <h3 className="text-xs uppercase text-[var(--graphite)] mb-2">Brush options</h3>
          <div className="flex gap-1 mb-3">
            <button
              onClick={() => setBrushMode('mask-edit')}
              className={`flex-1 text-xs py-1.5 rounded-[var(--radius-sm)] border ${brushMode === 'mask-edit' ? 'bg-[var(--signal)] text-white border-transparent' : 'border-[var(--line)]'}`}
            >
              Edit mask
            </button>
            <button
              onClick={() => setBrushMode('direct-paint')}
              className={`flex-1 text-xs py-1.5 rounded-[var(--radius-sm)] border ${brushMode === 'direct-paint' ? 'bg-[var(--signal)] text-white border-transparent' : 'border-[var(--line)]'}`}
            >
              Direct paint
            </button>
          </div>
          {brushMode === 'mask-edit' && !activeLayerId && (
            <p className="text-xs text-[var(--warning)] mb-2">Select a layer first — hold Alt to subtract.</p>
          )}
          {brushMode === 'mask-edit' && activeLayerId && (
            <div className="flex gap-1 mb-3">
              <button
                onClick={() => setMaskRefineMode('add')}
                className={`flex-1 text-xs py-1.5 rounded-[var(--radius-sm)] border ${maskRefineMode === 'add' ? 'bg-[var(--signal)] text-white border-transparent' : 'border-[var(--line)]'}`}
              >
                Add to mask
              </button>
              <button
                onClick={() => setMaskRefineMode('remove')}
                className={`flex-1 text-xs py-1.5 rounded-[var(--radius-sm)] border ${maskRefineMode === 'remove' ? 'bg-[var(--signal)] text-white border-transparent' : 'border-[var(--line)]'}`}
              >
                Remove from mask
              </button>
            </div>
          )}
          <label className="text-xs text-[var(--graphite)]">Brush size — {brushSize}px</label>
          <Slider min={10} max={200} value={[brushSize]} onValueChange={([v]) => setBrushSize(v)} />

          <div className="mt-4 flex items-center justify-between gap-2">
            <label htmlFor="surface-aware" className="text-xs text-[var(--graphite)]">Surface-aware painting</label>
            <button
              id="surface-aware"
              role="switch"
              aria-checked={surfaceAware}
              onClick={() => setSurfaceAware(!surfaceAware)}
              className={`relative h-5 w-9 rounded-full transition-colors ${surfaceAware ? 'bg-[var(--signal)]' : 'bg-[var(--line)]'}`}
            >
              <span
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${surfaceAware ? 'translate-x-[18px]' : 'translate-x-0.5'}`}
              />
            </button>
          </div>
          {surfaceAware && (
            <>
              <label className="text-xs text-[var(--graphite)] mt-2">Boundary sensitivity — {surfaceTolerance}</label>
              <Slider min={8} max={60} value={[surfaceTolerance]} onValueChange={([v]) => setSurfaceTolerance(v)} />
              <p className="text-[11px] text-[var(--graphite)] leading-snug mt-2">
                Keeps paint inside walls and stops at railings, frames, glass, wires and other strong edges.
                Lower = stricter. Turn off for freehand work.
              </p>
            </>
          )}
          {activeLayer?.ai_surface_key && (
            <div className="mt-4 flex items-center justify-between gap-2">
              <label htmlFor="ai-surface-lock" className="text-xs text-[var(--graphite)]">Constrain to AI surface</label>
              <button
                id="ai-surface-lock"
                role="switch"
                aria-checked={aiSurfaceLock}
                onClick={() => setAiSurfaceLock(!aiSurfaceLock)}
                className={`relative h-5 w-9 rounded-full transition-colors ${aiSurfaceLock ? 'bg-[var(--signal)]' : 'bg-[var(--line)]'}`}
              >
                <span
                  className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${aiSurfaceLock ? 'translate-x-[18px]' : 'translate-x-0.5'}`}
                />
              </button>
            </div>
          )}
          {activeLayer?.ai_surface_key && aiSurfaceLock && (
            <p className="text-[11px] text-[var(--graphite)] leading-snug mt-2">
              This layer came from AI analysis — strokes are locked inside the detected
              “{activeLayer.ai_surface_key}” surface. Turn off for freehand refinement.
            </p>
          )}
        </section>
      )}

      {activeTool === 'eraser' && (
        <section>
          <h3 className="text-xs uppercase text-[var(--graphite)] mb-2">Eraser</h3>
          <label className="text-xs text-[var(--graphite)]">Eraser size — {brushSize}px</label>
          <Slider min={10} max={200} value={[brushSize]} onValueChange={([v]) => setBrushSize(v)} />
          <p className="text-[11px] text-[var(--graphite)] leading-snug mt-2">
            Erases whichever layer's paint is under the stroke — no need to select a layer first. Never touches the
            photo or other layers; erasing a layer's last paint removes it entirely, and it's all undoable.
          </p>
        </section>
      )}

      {activeTool === 'magic-wand' && (
        <section>
          <h3 className="text-xs uppercase text-[var(--graphite)] mb-2">Magic Wand</h3>
          <label className="text-xs text-[var(--graphite)]">Tolerance — {magicWandTolerance}</label>
          <Slider min={2} max={80} value={[magicWandTolerance]} onValueChange={([v]) => setMagicWandTolerance(v)} />
          <p className="text-[11px] text-[var(--graphite)] leading-snug mt-1">
            How similar a pixel's color must be to grow the selection. Spreading still stops at real edges
            (shadows, trim, windows) regardless of this value — raising it does not select unrelated surfaces.
          </p>

          <label className="text-xs text-[var(--graphite)] mt-3 block">Edge smoothing — {magicWandFeather.toFixed(1)}px</label>
          <Slider min={0} max={4} step={0.5} value={[magicWandFeather]} onValueChange={([v]) => setMagicWandFeather(v)} />
          <p className="text-[11px] text-[var(--graphite)] leading-snug mt-1">
            Softens the selection's outer edge only. Higher values reduce jagged edges; lower values keep
            boundaries crisp against architectural detail.
          </p>

          <div className="mt-4 flex items-center justify-between gap-2">
            <label htmlFor="magic-wand-debug" className="text-xs text-[var(--graphite)]">Debug: show mask stages</label>
            <button
              id="magic-wand-debug"
              role="switch"
              aria-checked={magicWandDebugEnabled}
              onClick={() => setMagicWandDebugEnabled(!magicWandDebugEnabled)}
              className={`relative h-5 w-9 rounded-full transition-colors ${magicWandDebugEnabled ? 'bg-[var(--signal)]' : 'bg-[var(--line)]'}`}
            >
              <span
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${magicWandDebugEnabled ? 'translate-x-[18px]' : 'translate-x-0.5'}`}
              />
            </button>
          </div>
          {magicWandDebugEnabled && !magicWandDebug && (
            <p className="text-[11px] text-[var(--graphite)] leading-snug mt-2">Click the wall with Magic Wand to capture a selection.</p>
          )}
          {magicWandDebugEnabled && magicWandDebug && (
            <div className="mt-2 grid grid-cols-3 gap-1.5">
              {[
                ['Raw', magicWandDebug.raw],
                ['Holes closed', magicWandDebug.closed],
                ['Final (feathered)', magicWandDebug.final],
              ].map(([label, src]) => (
                <div key={label} className="flex flex-col gap-1">
                  <img src={src} alt={label} className="w-full rounded-[var(--radius-sm)] border border-[var(--line)] bg-black/80" />
                  <span className="text-[10px] text-[var(--graphite)] text-center leading-tight">{label}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {activeLayer && (
        <section>
          <h3 className="text-xs uppercase text-[var(--graphite)] mb-2">Surface properties</h3>
          <label className="flex flex-col gap-1 text-xs mb-2">
            <span className="text-[var(--graphite)]">Name</span>
            <input
              defaultValue={activeLayer.name}
              onBlur={(e) => {
                if (e.target.value === activeLayer.name) return;
                commit({ action: 'name-changed', layerId: activeLayer.id, before: { name: activeLayer.name }, after: { name: e.target.value } });
              }}
              className="rounded-[var(--radius-sm)] border border-[var(--line)] px-2 py-1"
            />
          </label>
          {activeLayer.ai_surface_key && (
            <p className="mb-2 inline-flex w-fit items-center rounded-[var(--radius-sm)] bg-[var(--signal)]/10 px-2 py-0.5 text-[10px] font-medium text-[var(--signal-dark)]">
              AI surface · {activeLayer.ai_surface_key}
            </p>
          )}
          <label className="flex flex-col gap-1 text-xs mb-2">
            <span className="text-[var(--graphite)]">Opacity — {Math.round(Number(activeLayer.opacity) * 100)}%</span>
            <Slider
              min={0}
              max={1}
              step={0.01}
              value={[Number(activeLayer.opacity)]}
              onValueChange={([v]) => updateLayer.mutate({ layerId: activeLayer.id, patch: { opacity: v } })}
              onValueCommit={([v]) => {
                commit({ action: 'opacity-changed', layerId: activeLayer.id, before: { opacity: opacityBeforeDrag.current }, after: { opacity: v } });
                opacityBeforeDrag.current = v;
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-[var(--graphite)]">Finish override</span>
            <input
              defaultValue={activeLayer.finish_override || ''}
              placeholder="e.g. eggshell"
              onBlur={(e) => {
                const value = e.target.value || null;
                if (value === activeLayer.finish_override) return;
                commit({ action: 'finish-changed', layerId: activeLayer.id, before: { finishOverride: activeLayer.finish_override || null }, after: { finishOverride: value } });
              }}
              className="rounded-[var(--radius-sm)] border border-[var(--line)] px-2 py-1"
            />
          </label>
        </section>
      )}

      {!activeTool && !activeLayer && (
        <p className="text-xs text-[var(--graphite)]">
          Open the Colors tab to browse catalog paints — hover a swatch to preview it live on the
          canvas, click to apply.
        </p>
      )}
    </div>
  );
}
