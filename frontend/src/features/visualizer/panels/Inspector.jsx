import { useEffect, useRef } from 'react';
import { useLayersList, useUpdateLayer } from '../hooks/useLayers';
import { useHistoryCommand } from '../hooks/useHistoryCommand';
import { useVisualizerStore } from '../store/visualizerStore';
import { Slider } from '../../../shared/ui/slider';

// Right inspector — contents change with the active tool (requirements doc,
// Section 5.1): brush options while painting, layer properties whenever a
// layer is selected. Color browsing itself lives in the left side panel's
// Catalog/Favorites/Brands/Collections sections (Phase 3) — pendingColorId
// is global store state, so picking a color there while a layer is selected
// here still applies it immediately; no duplicate picker needed in both places.
export default function Inspector({ projectId, assetId, onOpenExport }) {
  const activeTool = useVisualizerStore((s) => s.activeTool);
  const brushMode = useVisualizerStore((s) => s.brushMode);
  const setBrushMode = useVisualizerStore((s) => s.setBrushMode);
  const maskRefineMode = useVisualizerStore((s) => s.maskRefineMode);
  const setMaskRefineMode = useVisualizerStore((s) => s.setMaskRefineMode);
  const brushSize = useVisualizerStore((s) => s.brushSize);
  const setBrushSize = useVisualizerStore((s) => s.setBrushSize);
  const magicWandTolerance = useVisualizerStore((s) => s.magicWandTolerance);
  const setMagicWandTolerance = useVisualizerStore((s) => s.setMagicWandTolerance);
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
    <div className="w-[300px] shrink-0 border-l border-[var(--line)] bg-[var(--paper-raised)] flex flex-col h-full overflow-y-auto">
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
            {!activeLayerId && (
              <p className="text-xs text-[var(--warning)] mb-2">
                Select a layer first — the eraser only removes paint from the active layer.
              </p>
            )}
            <label className="text-xs text-[var(--graphite)]">Eraser size — {brushSize}px</label>
            <Slider min={10} max={200} value={[brushSize]} onValueChange={([v]) => setBrushSize(v)} />
            <p className="text-[11px] text-[var(--graphite)] leading-snug mt-2">
              Erases the active layer's paint only — it never touches the photo or other layers, and can be undone.
            </p>
          </section>
        )}

        {activeTool === 'magic-wand' && (
          <section>
            <h3 className="text-xs uppercase text-[var(--graphite)] mb-2">Magic Wand</h3>
            <label className="text-xs text-[var(--graphite)]">Tolerance — {magicWandTolerance}</label>
            <Slider min={2} max={80} value={[magicWandTolerance]} onValueChange={([v]) => setMagicWandTolerance(v)} />
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
            Open Paint Catalog, Favorites, Brands, or Collections in the left panel to browse colors — hover a swatch to
            preview it live on the canvas, click to apply.
          </p>
        )}
      </div>

      <div className="mt-auto border-t border-[var(--line)] p-3">
        <button onClick={onOpenExport} className="w-full text-sm py-2 rounded-[var(--radius-sm)] bg-[var(--signal)] text-white font-medium">
          Export
        </button>
      </div>
    </div>
  );
}
