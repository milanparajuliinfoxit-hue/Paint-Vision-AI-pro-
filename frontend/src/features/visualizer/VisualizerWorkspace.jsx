import { useEffect, useMemo, useState } from 'react';
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
import { useToast } from '../../shared/ui/toast';
import { useMediaQuery } from '../../shared/lib/useMediaQuery';

import CanvasStage from './canvas/CanvasStage';
import Toolbar from './panels/Toolbar';
import SidePanel from './panels/SidePanel';
import Inspector from './panels/Inspector';
import SaveStatusIndicator from './panels/SaveStatusIndicator';
import ExportPanel from './panels/ExportPanel';
import ComparisonPreview from './panels/ComparisonPreview';
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
  const { commit, commitMaskEdit, commitCreate, undo, redo, jumpTo, undoPointer, canUndo, canRedo } = useHistoryCommand(projectId, activeAssetId);

  const { data: catalogData } = useCatalogList({ pageSize: 2000 });
  const catalogRows = catalogData?.rows || [];
  // Stable reference across renders — otherwise every parent re-render (e.g.
  // SaveStatusIndicator's mutation-driven updates) would look like a "new"
  // colorLookup to CanvasStage/ExportPanel and re-trigger their effects.
  const colorLookup = useMemo(() => {
    const byId = new Map(catalogRows.map((p) => [p.id, { r: p.r_value, g: p.g_value, b: p.b_value }]));
    return (paintId) => (paintId ? byId.get(paintId) || null : null);
  }, [catalogRows]);

  useEffect(() => {
    if (pendingColorRgb) onColorFocus?.(rgbToHex(pendingColorRgb));
  }, [pendingColorRgb, onColorFocus]);

  // Global undo/redo keyboard shortcuts.
  useEffect(() => {
    function onKeyDown(e) {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.key === 'z' && e.shiftKey) || e.key === 'y') { e.preventDefault(); redo(); }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo, redo]);

  async function handleCommitMask(maskImageData, createdVia, opts = {}) {
    // Dedicated eraser tool (Phase 6): always subtracts from the active
    // layer's existing mask, regardless of brush mode/Alt state. Never
    // touches the original photo — it only shrinks a paint mask.
    if (createdVia === 'eraser') {
      if (!activeLayerId) {
        showToast('Select a layer first to erase paint from it.', { variant: 'danger' });
        return;
      }
      const activeLayer = layerList.find((l) => l.id === activeLayerId);
      if (!activeLayer?.mask_path) return; // nothing painted on this layer yet
      const existingMask = await loadMaskImageData(assetsApi.fileUrl(activeLayer.mask_path), width, height);
      const merged = mergeMasks(existingMask, maskImageData, 'subtract');
      const blob = await imageDataToPngBlob(merged);
      await commitMaskEdit({ action: 'mask-edited', layerId: activeLayerId, maskBlob: blob, beforeMaskPath: activeLayer.mask_path });
      return;
    }

    // Mask-edit mode refines an *existing* layer's mask rather than
    // producing a new one (requirements doc, Section 5.2).
    if (createdVia === 'brush' && opts.brushMode === 'mask-edit' && activeLayerId) {
      const activeLayer = layerList.find((l) => l.id === activeLayerId);
      let merged = maskImageData;
      if (activeLayer?.mask_path) {
        const existingMask = await loadMaskImageData(assetsApi.fileUrl(activeLayer.mask_path), width, height);
        merged = mergeMasks(existingMask, maskImageData, opts.subtract ? 'subtract' : 'add');
      } else if (opts.subtract) {
        return; // nothing to subtract from
      }
      const blob = await imageDataToPngBlob(merged);
      await commitMaskEdit({ action: 'mask-edited', layerId: activeLayerId, maskBlob: blob, beforeMaskPath: activeLayer?.mask_path });
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

  function handleBucketFill() {
    if (!activeLayerId || !pendingColorId) {
      showToast('Select a layer and a catalog color first.', { variant: 'danger' });
      return;
    }
    const activeLayer = layerList.find((l) => l.id === activeLayerId);
    commit({
      action: 'color-applied',
      layerId: activeLayerId,
      before: { currentColorId: activeLayer?.current_color_id ?? null },
      after: { currentColorId: pendingColorId },
    });
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
    for (const paint of catalogRows) {
      const lab = rgbToLab(paint.r_value, paint.g_value, paint.b_value);
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
      onJumpTo={jumpTo}
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
                <Button size="icon" variant="ghost" onClick={undo} disabled={!canUndo} aria-label="Undo">
                  <Undo2 size={15} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Undo (Ctrl+Z)</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon" variant="ghost" onClick={redo} disabled={!canRedo} aria-label="Redo">
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
            onBucketFill={handleBucketFill}
            onEyedropper={handleEyedropper}
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

function loadMaskImageData(url, width, height) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      resolve(ctx.getImageData(0, 0, width, height));
    };
    img.onerror = reject;
    img.src = url;
  });
}

function rgbToHex({ r, g, b }) {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}
