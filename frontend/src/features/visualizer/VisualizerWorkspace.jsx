import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useProject } from '../projects/useProjects';
import { useAssetsList } from './hooks/useAssets';
import { useLayersList, useCreateLayer } from './hooks/useLayers';
import { useHistoryCommand } from './hooks/useHistoryCommand';
import { useIndexedDraft } from './hooks/useIndexedDraft';
import { useCatalogList } from '../catalog/useCatalogList';
import { useVisualizerStore } from './store/visualizerStore';
import { useImageElement } from './canvas/useImageElement';
import { imageDataToPngBlob, mergeMasks } from './tools/maskOps';
import { rgbToLab } from '../../shared/lib/colorEngine';
import { assets as assetsApi } from '../../shared/lib/api';
import { loadMaskImageData } from '../../shared/lib/maskImage';
import { useAssetAnalysis, useSurfaceConstraintAlpha, useSurfaceAlphaGrids } from './hooks/useAiAnalysis';
import { useApplySurface } from './hooks/useApplySurface';
import { useToast } from '../../shared/ui/toast';
import { useMediaQuery } from '../../shared/lib/useMediaQuery';

import CanvasStage from './canvas/CanvasStage';
import Toolbar from './panels/Toolbar';
import SidePanel from './panels/SidePanel';
import Inspector from './panels/Inspector';
import SaveStatusIndicator from './panels/SaveStatusIndicator';
import ExportPanel from './panels/ExportPanel';
import ComparisonPreview from './panels/ComparisonPreview';
import AiPipelineStatusBar from './panels/AiPipelineStatusBar';
import { Button } from '../../shared/ui/button';
import { Sheet, SheetTrigger, SheetContent } from '../../shared/ui/sheet';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from '../../shared/ui/tooltip';
import { cn } from '../../shared/lib/cn';
import { ChevronLeft, Download, Image as ImageIcon, Info, Paintbrush, PanelLeft, Redo2, Undo2, Wand2 } from 'lucide-react';

const DEFAULT_LAYER_NAME = {
  rect: 'Rectangle selection', lasso: 'Lasso selection', polygon: 'Polygon selection',
  'magic-wand': 'Magic Wand selection', brush: 'Brush selection', 'ai-surface': 'AI surface',
};

export default function VisualizerWorkspace({ onColorFocus }) {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { data: project } = useProject(projectId);
  const { data: assetList = [] } = useAssetsList(projectId);
  const showToast = useToast();

  const activeAssetId = useVisualizerStore((s) => s.activeAssetId);
  const setActiveAssetId = useVisualizerStore((s) => s.setActiveAssetId);
  const activeLayerId = useVisualizerStore((s) => s.activeLayerId);
  const setActiveLayerId = useVisualizerStore((s) => s.setActiveLayerId);
  const pendingColorId = useVisualizerStore((s) => s.pendingColorId);
  const pendingColorRgb = useVisualizerStore((s) => s.pendingColorRgb);
  const setPendingColor = useVisualizerStore((s) => s.setPendingColor);
  const aiSurfaceLock = useVisualizerStore((s) => s.aiSurfaceLock);
  const compareState = useVisualizerStore((s) => s.compareState);
  const setCompareState = useVisualizerStore((s) => s.setCompareState);

  const [showExport, setShowExport] = useState(false);
  const [showLeftSheet, setShowLeftSheet] = useState(false);
  const [showRightSheet, setShowRightSheet] = useState(false);

  // Full 3-pane layout >=1280px; sidebar -> icon rail + Sheet and inspector
  // -> slide-over Sheet at 768-1279px; <768px is read/compare-only with
  // editing disabled and a clear message, not a silently broken layout
  // (requirements doc, Section 12).
  const isMobile = useMediaQuery('(max-width: 767px)');

  useIndexedDraft(projectId);

  // Default to the most recently uploaded asset once assets load.
  useEffect(() => {
    if (!activeAssetId && assetList.length > 0) setActiveAssetId(assetList[assetList.length - 1].id);
  }, [assetList, activeAssetId, setActiveAssetId]);

  const activeAsset = assetList.find((a) => a.id === activeAssetId);
  const showCleaned = compareState === 'cleaned' || (compareState === 'painted' && !!activeAsset?.cleaned_path);
  const baseImageUrl = activeAsset
    ? assetsApi.fileUrl(showCleaned && activeAsset.cleaned_path ? activeAsset.cleaned_path : activeAsset.original_path)
    : null;

  const { image: baseImage, width, height, loading: imageLoading, error: imageError } = useImageElement(baseImageUrl);
  const baseImageData = useMemo(() => {
    if (!baseImage || !width || !height) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(baseImage, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
  }, [baseImage, width, height]);

  const { data: layerList = [] } = useLayersList(activeAssetId);
  const createLayer = useCreateLayer(activeAssetId);
  const { commitMaskEdit, commitCreate, undo, redo, jumpTo, undoPointer, canUndo, canRedo } = useHistoryCommand(projectId, activeAssetId);

  // Surface lock: when the active layer came from AI analysis (it carries an
  // ai_surface_key), clip brush strokes to that surface's detected mask so
  // paint cannot escape the surface the AI identified.
  const activeLayer = layerList.find((l) => l.id === activeLayerId);
  const { data: analysis } = useAssetAnalysis(activeAssetId);
  const constraintAlpha = useSurfaceConstraintAlpha({
    analysis,
    surfaceKey: aiSurfaceLock ? activeLayer?.ai_surface_key : null,
    width,
    height,
  });

  // Alpha grids of every paintable detected surface at canvas resolution —
  // the surface-pick tool hit-tests a click against these to resolve which
  // wall/roof/etc. the dealer clicked, then paints the whole surface.
  const surfaceMasks = useSurfaceAlphaGrids({ analysis, width, height });
  const { applySurface } = useApplySurface(projectId, activeAssetId, { width, height });

  // Semantic painting: clicking a detected surface creates (or updates, via
  // the idempotent AI-layer upsert) the whole-surface layer and paints it with
  // the currently selected catalog color, if any.
  async function handleSurfacePick(surface) {
    try {
      const paint = pendingColorId ? { id: pendingColorId } : null;
      const layer = await applySurface(surface, paint);
      showToast(layer
        ? `Surface selected: ${surface.display_name || surface.class_key}${paint ? ' — painted with the selected catalog color.' : ' — pick a catalog color to paint it.'}`
        : 'No paintable surface under the cursor.');
    } catch (err) {
      showToast(err.message || 'Could not apply surface.', { variant: 'danger' });
    }
  }

  // In-memory mask cache, keyed by layer id + the mask_path it was built
  // from. Without it every brush/eraser stroke re-downloaded the layer's
  // PNG and merged against whatever mask_path the (possibly stale) query
  // cache reported — two quick strokes could both merge against the *old*
  // mask and the second one silently dropped the first (the "seams between
  // strokes" defect). Merging against this cache is synchronous after the
  // first fetch, so consecutive strokes always stack on the latest result.
  // The path key auto-invalidates when history undo/redo re-points mask_path.
  const maskCacheRef = useRef(new Map());
  const clearMaskCache = () => maskCacheRef.current.clear();
  useEffect(() => () => clearMaskCache(), []);
  useEffect(() => { clearMaskCache(); }, [activeAssetId]);

  async function getLayerMaskData(layer) {
    const cached = maskCacheRef.current.get(layer.id);
    if (cached && cached.path === layer.mask_path) return cached.imageData;
    const imageData = await loadMaskImageData(assetsApi.fileUrl(layer.mask_path), width, height);
    if (maskCacheRef.current.size >= 16) {
      maskCacheRef.current.delete(maskCacheRef.current.keys().next().value);
    }
    maskCacheRef.current.set(layer.id, { path: layer.mask_path, imageData });
    return imageData;
  }

  // Mask writes are serialized through a promise chain. Without it two quick
  // strokes fire two PATCH requests that could complete out of order, and
  // the server row would end up pointing at the older (less complete) mask
  // even though the newest file was uploaded — a silent rollback of paint.
  const maskWriteQueueRef = useRef(Promise.resolve());
  function enqueueMaskWrite(work) {
    const run = maskWriteQueueRef.current.then(work, work);
    maskWriteQueueRef.current = run.catch(() => {});
    return run;
  }

  // Read-merge-upload for a stroke on an existing layer. Uses the in-memory
  // cache as the merge base so consecutive strokes always stack on the latest
  // result (no per-stroke PNG refetch, no stale base).
  function mergeMaskIntoLayer(layer, strokeMask, mode) {
    return enqueueMaskWrite(async () => {
      const existing = await getLayerMaskData(layer);
      const merged = mergeMasks(existing, strokeMask, mode);
      maskCacheRef.current.set(layer.id, { path: layer.mask_path, imageData: merged });
      const blob = await imageDataToPngBlob(merged);
      return commitMaskEdit({ action: 'mask-edited', layerId: layer.id, maskBlob: blob, beforeMaskPath: layer.mask_path });
    });
  }

  // Undo/redo/jump re-point layer masks server-side; the cache key would
  // collide (an undo back to an earlier path looks like a hit), so drop it.
  const undoWithCache = () => { clearMaskCache(); undo(); };
  const redoWithCache = () => { clearMaskCache(); redo(); };
  const jumpToWithCache = (i) => { clearMaskCache(); jumpTo(i); };

  const { data: catalogData } = useCatalogList({ pageSize: 2000 });
  const catalogRows = catalogData?.rows || [];
  // Stable reference across renders — otherwise every parent re-render (e.g.
  // SaveStatusIndicator's mutation-driven updates) would look like a "new"
  // colorLookup to CanvasStage/ExportPanel and re-trigger their effects.
  const colorLookup = useMemo(() => {
    const byId = new Map(catalogRows.map((p) => [p.id, { r: p.r_value, g: p.g_value, b: p.b_value }]));
    return (paintId) => (paintId ? byId.get(paintId) || null : null);
  }, [catalogRows]);

  // Precomputed once per catalog load instead of per eyedropper click —
  // rgbToLab is a handful of pow()/cbrt() calls per paint, and re-running it
  // over the full catalog (up to 2000 rows) on every click was pure waste
  // since the catalog's own colors never change between clicks.
  const catalogLab = useMemo(
    () => catalogRows.map((paint) => ({ paint, lab: rgbToLab(paint.r_value, paint.g_value, paint.b_value) })),
    [catalogRows]
  );

  useEffect(() => {
    if (pendingColorRgb) onColorFocus?.(rgbToHex(pendingColorRgb));
  }, [pendingColorRgb, onColorFocus]);

  // Global undo/redo keyboard shortcuts.
  useEffect(() => {
    function onKeyDown(e) {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); undoWithCache(); }
      if ((e.key === 'z' && e.shiftKey) || e.key === 'y') { e.preventDefault(); redoWithCache(); }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undoWithCache, redoWithCache]);

  async function handleCommitMask(maskImageData, createdVia, opts = {}) {
    // Dedicated eraser tool: always subtracts from the active layer's
    // existing mask, regardless of brush mode/Alt state. Never touches the
    // original photo or any other layer — it only shrinks a paint mask.
    if (createdVia === 'eraser') {
      if (!activeLayerId) {
        showToast('Select a layer first to erase paint from it.', { variant: 'danger' });
        return;
      }
      const activeLayer = layerList.find((l) => l.id === activeLayerId);
      if (!activeLayer?.mask_path) return; // nothing painted on this layer yet
      await mergeMaskIntoLayer(activeLayer, maskImageData, 'subtract');
      return;
    }

    // Mask-edit mode refines an *existing* layer's mask rather than
    // producing a new one (requirements doc, Section 5.2).
    if (createdVia === 'brush' && opts.brushMode === 'mask-edit' && activeLayerId) {
      const activeLayer = layerList.find((l) => l.id === activeLayerId);
      if (!activeLayer?.mask_path) {
        if (opts.subtract) return; // nothing to subtract from
        // First paint on this layer: no base to merge, just the stroke itself.
        const blob = await imageDataToPngBlob(maskImageData);
        await commitMaskEdit({ action: 'mask-edited', layerId: activeLayerId, maskBlob: blob, beforeMaskPath: null });
        return;
      }
      await mergeMaskIntoLayer(activeLayer, maskImageData, opts.subtract ? 'subtract' : 'add');
      return;
    }

    const blob = await imageDataToPngBlob(maskImageData);
    const layer = await createLayer.mutateAsync({
      fields: {
        name: DEFAULT_LAYER_NAME[createdVia] || 'New layer',
        createdVia,
        currentColorId: pendingColorId || undefined,
        orderIndex: layerList.length,
      },
      maskBlob: blob,
    });
    setActiveLayerId(layer.id);
    commitCreate({ layerId: layer.id, createdVia });
  }

  function handleEyedropper(pt) {
    if (!baseImageData) return;
    const x = Math.min(width - 1, Math.max(0, Math.round(pt.x)));
    const y = Math.min(height - 1, Math.max(0, Math.round(pt.y)));
    const i = (y * width + x) * 4;
    const sampled = { r: baseImageData.data[i], g: baseImageData.data[i + 1], b: baseImageData.data[i + 2] };
    const sampledLab = rgbToLab(sampled.r, sampled.g, sampled.b);

    let nearest = null;
    let nearestDist = Infinity;
    for (const { paint, lab } of catalogLab) {
      const dist = Math.sqrt((lab.l - sampledLab.l) ** 2 + (lab.a - sampledLab.a) ** 2 + (lab.b - sampledLab.b) ** 2);
      if (dist < nearestDist) { nearestDist = dist; nearest = paint; }
    }
    if (nearest) {
      setPendingColor(nearest.id, { r: nearest.r_value, g: nearest.g_value, b: nearest.b_value });
      showToast(`Closest catalog match: ${nearest.color_name} (${nearest.color_code})`);
    }
  }

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--paper)]">
        <div className="fade-in flex flex-col items-center gap-3">
          <div className="skeleton h-8 w-8 rounded-full" />
          <div className="skeleton h-3 w-44 rounded" />
          <div className="text-xs text-[var(--graphite)]">Loading project…</div>
        </div>
      </div>
    );
  }

  const compareOptions = [
    { id: 'original', label: 'Original', Icon: ImageIcon },
    { id: 'cleaned', label: 'Cleaned', Icon: Wand2 },
    { id: 'painted', label: 'Painted', Icon: Paintbrush },
  ];

  const sidePanel = (
    <SidePanel
      projectId={projectId}
      assetId={activeAssetId}
      colorLookup={colorLookup}
      undoPointer={undoPointer}
      onJumpTo={jumpToWithCache}
      onSelectAsset={setActiveAssetId}
      baseImageData={baseImageData}
      width={width}
      height={height}
    />
  );

  const header = (
    <header className="flex items-center gap-3 border-b border-[var(--line)] bg-[var(--paper-raised)] px-4 py-2.5">
      <button
        onClick={() => navigate('/projects')}
        aria-label="Back to projects"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--graphite)] transition-colors hover:bg-[var(--paper)] hover:text-[var(--ink)]"
      >
        <ChevronLeft size={18} strokeWidth={2} />
      </button>

      <div className="min-w-0">
        <div className="truncate text-sm font-semibold leading-tight">{project.name || project.client_name}</div>
        <div className="truncate text-xs leading-tight text-[var(--graphite)]">{project.client_name}</div>
      </div>

      <div className="ml-3 hidden items-center gap-0.5 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--paper)] p-0.5 sm:flex">
        {compareOptions.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setCompareState(id)}
            aria-pressed={compareState === id}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-xs font-medium transition-colors',
              compareState === id
                ? 'bg-[var(--signal)] text-white'
                : 'text-[var(--graphite)] hover:text-[var(--ink)]'
            )}
          >
            <Icon size={13} strokeWidth={2} />
            {label}
          </button>
        ))}
      </div>

      {!isMobile && (
        <div className="ml-1 hidden items-center gap-1 sm:flex">
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon" variant="ghost" onClick={undoWithCache} disabled={!canUndo} aria-label="Undo">
                  <Undo2 size={15} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Undo (Ctrl+Z)</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon" variant="ghost" onClick={redoWithCache} disabled={!canRedo} aria-label="Redo">
                  <Redo2 size={15} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Redo (Ctrl+Shift+Z)</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      )}

      <div className="ml-auto flex items-center gap-3">
        <SaveStatusIndicator />
        <Button size="sm" className="hidden md:inline-flex" onClick={() => setShowExport(true)}>
          <Download size={14} strokeWidth={2.5} /> Export
        </Button>
      </div>
    </header>
  );

  // <768px: editing tools disabled with a clear message rather than a
  // silently broken canvas (requirements doc, Section 12's intentional
  // constraint, not a bug).
  if (isMobile) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        {header}
        <AiPipelineStatusBar assetId={activeAssetId} />
        <div className="flex items-center gap-2 border-b border-[var(--warning)]/20 bg-[var(--warning)]/10 px-4 py-2 text-xs font-medium text-[var(--graphite-dark)]">
          <Info size={14} className="shrink-0 text-[var(--warning)]" />
          Editing tools need more screen space — this view is read/compare-only on phone-sized screens.
        </div>
        <div className="p-4 overflow-y-auto">
          <ComparisonPreview
            mode="slider"
            beforeSrc={activeAsset ? assetsApi.fileUrl(activeAsset.original_path) : null}
            afterSrc={baseImage?.src}
            beforeLabel="Original"
            afterLabel={compareState === 'cleaned' ? 'Cleaned' : 'Painted'}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {header}
      <AiPipelineStatusBar assetId={activeAssetId} />

      <div className="flex flex-1 min-h-0">
        {/* Full side panel >=1280px */}
        <aside className="hidden xl:flex w-[300px] shrink-0 border-r border-[var(--line)] bg-[var(--paper-raised)] flex-col">
          {sidePanel}
        </aside>

        {/* Slide-over Sheet at 768-1279px — the panel keeps its own icon rail */}
        <Sheet open={showLeftSheet} onOpenChange={setShowLeftSheet}>
          <nav className="xl:hidden flex flex-col gap-1 border-r border-[var(--line)] bg-[var(--paper-raised)] p-2">
            <SheetTrigger asChild>
              <button aria-label="Open panel" className="h-9 w-9 flex items-center justify-center rounded-[var(--radius-sm)] hover:bg-[var(--paper)]">
                <PanelLeft size={17} strokeWidth={2} />
              </button>
            </SheetTrigger>
          </nav>
          <SheetContent open={showLeftSheet} side="left">
            {sidePanel}
          </SheetContent>
        </Sheet>

        <div className="relative flex-1 min-w-0">
          <div className="absolute top-3 left-3 z-10">
            <Toolbar />
          </div>
          <CanvasStage
            baseImage={baseImage}
            baseImageData={baseImageData}
            width={width}
            height={height}
            loading={imageLoading}
            error={imageError}
            layers={layerList}
            colorLookup={colorLookup}
            onCommitMask={handleCommitMask}
            onEyedropper={handleEyedropper}
            constraintAlpha={constraintAlpha}
            surfaceMasks={surfaceMasks}
            onSurfacePick={handleSurfacePick}
          />
        </div>

        <div className="hidden xl:flex">
          <Inspector projectId={projectId} assetId={activeAssetId} onOpenExport={() => setShowExport(true)} />
        </div>
        <Sheet open={showRightSheet} onOpenChange={setShowRightSheet}>
          <SheetTrigger asChild>
            <button
              aria-label="Open inspector"
              className="xl:hidden absolute top-3 right-3 z-10 h-9 w-9 rounded-[var(--radius-sm)] bg-[var(--ink)] text-white"
            >
              ⚙
            </button>
          </SheetTrigger>
          <SheetContent open={showRightSheet}>
            <Inspector projectId={projectId} assetId={activeAssetId} onOpenExport={() => setShowExport(true)} />
          </SheetContent>
        </Sheet>
      </div>

      <ExportPanel
        open={showExport}
        onOpenChange={setShowExport}
        projectId={projectId}
        baseImage={baseImage}
        baseImageData={baseImageData}
        width={width}
        height={height}
        layers={layerList}
        colorLookup={colorLookup}
        originalUrl={activeAsset ? assetsApi.fileUrl(activeAsset.original_path) : null}
        cleanedUrl={activeAsset?.cleaned_path ? assetsApi.fileUrl(activeAsset.cleaned_path) : null}
      />
    </div>
  );
}

function rgbToHex({ r, g, b }) {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}
