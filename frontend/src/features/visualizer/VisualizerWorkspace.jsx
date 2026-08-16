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
import { imageDataToPngBlob, mergeMasks, isMaskEmpty, masksOverlap, isPointInsideAlpha, countMaskPixels } from './tools/maskOps';
import { isColorMismatch } from './hooks/colorOwnership';
import { rgbToLab } from '../../shared/lib/colorEngine';
import { assets as assetsApi } from '../../shared/lib/api';
import { loadMaskImageData } from '../../shared/lib/maskImage';
import { useAssetAnalysis, useSurfaceConstraintAlpha, useSurfaceAlphaGrids, useHouseProtectionAlpha } from './hooks/useAiAnalysis';
import { useApplySurface } from './hooks/useApplySurface';
import { useToast } from '../../shared/ui/toast';
import { useMediaQuery } from '../../shared/lib/useMediaQuery';
import { logger } from '../../shared/lib/logger';

import CanvasStage from './canvas/CanvasStage';
import Toolbar from './panels/Toolbar';
import SidePanel from './panels/SidePanel';
import Inspector from './panels/Inspector';
import SaveStatusIndicator from './panels/SaveStatusIndicator';
import ExportPanel from './panels/ExportPanel';
import ComparisonPreview from './panels/ComparisonPreview';
import AiPipelineStatusBar, { AiPipelineStatusChip } from './panels/AiPipelineStatusBar';
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
  const { commitMaskEdit, commitCreate, commitDelete, undo, redo, jumpTo, undoPointer, canUndo, canRedo } = useHistoryCommand(projectId, activeAssetId);

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
  // House-aware Magic Wand: union of every detected surface's mask (walls,
  // roof, trim, windows, doors — paintable or not), so a flood-fill
  // selection can never spread into sky/ground/neighboring structures no
  // matter how close the colors are. Null when no analysis has been run —
  // the tool still applies its own boundary-aware color/step tolerance.
  const houseAlpha = useHouseProtectionAlpha({ analysis, width, height });
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
  useEffect(() => { clearMaskCache(); setLocalMaskOverrides(new Map()); }, [activeAssetId]);

  // Instant-render override: the mask a stroke JUST produced, shown via
  // LayerNode's localMaskData prop immediately — no waiting on the PNG
  // upload -> layers-list refetch -> mask-file refetch chain that
  // otherwise gates every visible paint/erase result behind 2-3 sequential
  // network round trips (previously the actual source of the reported
  // multi-second paint/erase delay — see mergeMaskIntoLayer/eraseFromLayer).
  // Cleared once the server-confirmed state has caught up (persist
  // success); deliberately kept on persist *failure* so a save error never
  // reverts what the user already saw painted/erased.
  const [localMaskOverrides, setLocalMaskOverrides] = useState(() => new Map());
  function setLocalOverride(layerId, imageData) {
    setLocalMaskOverrides((prev) => new Map(prev).set(layerId, imageData));
  }
  function clearLocalOverride(layerId) {
    setLocalMaskOverrides((prev) => {
      if (!prev.has(layerId)) return prev;
      const next = new Map(prev);
      next.delete(layerId);
      return next;
    });
  }

  // Same instant-render idea for a layer that doesn't exist yet — a
  // selection tool's mask is ready to show immediately, but there is no
  // layer id to key an override by until the create request returns one.
  // A purely-visual preview (not inserted into the layers query cache)
  // avoids every other call site that assumes layer.id is a real database
  // integer needing to know about a temporary one.
  const [pendingNewLayer, setPendingNewLayer] = useState(null); // { maskImageData, colorRgb } | null

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

  // Read-merge-render-upload for a stroke on an existing layer. Uses the
  // in-memory cache as the merge base so consecutive strokes always stack
  // on the latest result (no per-stroke PNG refetch, no stale base). The
  // merged result renders via setLocalOverride the instant it's computed —
  // persistence (network) runs after, in the background, and never gates
  // what's on screen.
  function mergeMaskIntoLayer(layer, strokeMask, mode) {
    return enqueueMaskWrite(async () => {
      const existing = await getLayerMaskData(layer);
      const merged = mergeMasks(existing, strokeMask, mode);
      maskCacheRef.current.set(layer.id, { path: layer.mask_path, imageData: merged });
      setLocalOverride(layer.id, merged);

      const startedAt = performance.now();
      logger.info('paint.stroke.persist.started', { layerId: layer.id });
      try {
        const blob = await imageDataToPngBlob(merged);
        await commitMaskEdit({ action: 'mask-edited', layerId: layer.id, maskBlob: blob, beforeMaskPath: layer.mask_path });
        clearLocalOverride(layer.id);
        logger.info('paint.stroke.persist.completed', { layerId: layer.id, durationMs: Math.round(performance.now() - startedAt) });
      } catch (err) {
        // Local override deliberately NOT cleared — the stroke stays
        // visible exactly as painted; only the save failed, not the edit.
        logger.error('paint.stroke.persist.failed', { layerId: layer.id, message: err.message, durationMs: Math.round(performance.now() - startedAt) });
        showToast('This stroke is shown but not yet saved — check your connection.', { variant: 'danger' });
      }
    });
  }

  // Eraser-only: same read-merge shape as mergeMaskIntoLayer, but a stroke
  // that leaves nothing behind deletes the layer instead of persisting an
  // invisible empty mask. Not applied to the brush's mask-edit "subtract"
  // mode — that's a deliberate, precise editing action where an unexpected
  // layer deletion would be surprising, not helpful.
  function eraseFromLayer(layer, strokeMask) {
    return enqueueMaskWrite(async () => {
      const startedAt = performance.now();
      logger.info('erase.stroke.started', { layerId: layer.id });

      const existing = await getLayerMaskData(layer);
      const merged = mergeMasks(existing, strokeMask, 'subtract');

      if (isMaskEmpty(merged)) {
        // Nothing left to show. mask_path is deliberately left pointing at
        // the layer's last real (non-empty) mask file — the merged empty
        // result is never uploaded — so this is a single 'delete' command
        // through the existing soft-delete path: undo (restore-by-id)
        // brings the layer back exactly as it looked right before this
        // stroke, with no separate "revert the mask" step, and no wasted
        // upload of a mask nobody will ever see. commitDelete's underlying
        // mutation is optimistic (see useLayers.js), so the layer leaves
        // the canvas and the Layers panel immediately, not after a
        // round trip.
        logger.info('erase.layer.empty', { layerId: layer.id });
        maskCacheRef.current.delete(layer.id);
        clearLocalOverride(layer.id);
        commitDelete(layer);
        logger.info('erase.layer.auto_deleted', { layerId: layer.id, durationMs: Math.round(performance.now() - startedAt) });
        return;
      }

      setLocalOverride(layer.id, merged);
      logger.info('erase.stroke.completed', { layerId: layer.id, durationMs: Math.round(performance.now() - startedAt) });

      const persistStartedAt = performance.now();
      try {
        maskCacheRef.current.set(layer.id, { path: layer.mask_path, imageData: merged });
        const blob = await imageDataToPngBlob(merged);
        await commitMaskEdit({ action: 'mask-edited', layerId: layer.id, maskBlob: blob, beforeMaskPath: layer.mask_path });
        clearLocalOverride(layer.id);
        logger.info('erase.stroke.persist.completed', { layerId: layer.id, durationMs: Math.round(performance.now() - persistStartedAt) });
      } catch (err) {
        logger.error('erase.stroke.persist.failed', { layerId: layer.id, message: err.message, durationMs: Math.round(performance.now() - persistStartedAt) });
        showToast('This erase is shown but not yet saved — check your connection.', { variant: 'danger' });
      }
    });
  }

  // Resolves which layer an eraser stroke should act on without requiring
  // the dealer to have clicked it in the Layers panel first. Preference
  // order: the explicitly-selected layer if it's actually editable, else
  // the topmost visible+unlocked layer whose *own paint* the stroke
  // actually touches (layerList is order_index ASC i.e. bottom-to-top, so
  // scan in reverse) — never a hidden or locked layer, and never more than
  // one layer per stroke.
  async function resolveEraseTargetLayer(strokeMask) {
    if (activeLayerId) {
      const explicit = layerList.find((l) => l.id === activeLayerId);
      if (explicit && explicit.visible && !explicit.locked && explicit.mask_path) return explicit;
    }
    for (let i = layerList.length - 1; i >= 0; i--) {
      const layer = layerList[i];
      if (!layer.visible || layer.locked || !layer.mask_path) continue;
      const layerMask = await getLayerMaskData(layer);
      if (masksOverlap(layerMask, strokeMask)) return layer;
    }
    return null;
  }

  // Undo/redo/jump re-point layer masks server-side; the cache key would
  // collide (an undo back to an earlier path looks like a hit), so drop it.
  const undoWithCache = () => { clearMaskCache(); setLocalMaskOverrides(new Map()); undo(); };
  const redoWithCache = () => { clearMaskCache(); setLocalMaskOverrides(new Map()); redo(); };
  const jumpToWithCache = (i) => { clearMaskCache(); setLocalMaskOverrides(new Map()); jumpTo(i); };

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
    // Dedicated eraser tool: always subtracts, regardless of brush
    // mode/Alt state, from whichever layer resolveEraseTargetLayer decides
    // the stroke actually landed on — the dealer doesn't have to select a
    // layer in the panel first. Never touches the original photo or any
    // other layer — it only shrinks (or, if nothing's left, removes) one
    // paint layer.
    if (createdVia === 'eraser') {
      const targetLayer = await resolveEraseTargetLayer(maskImageData);
      if (!targetLayer) {
        showToast('Nothing painted there to erase.', { variant: 'danger' });
        return;
      }
      await eraseFromLayer(targetLayer, maskImageData);
      return;
    }

    // Magic Wand: reject a click that landed outside the detected house
    // region — or that, even with the tool's own boundary-aware flood fill
    // (see maskOps.floodFillMask), produced no connected selection at all —
    // instead of silently creating an empty/stray paint layer. Threshold
    // 128 (not floodFillMask's looser 32) because a *click* should land
    // solidly on a detected surface, not merely its soft feathered edge.
    if (createdVia === 'magic-wand') {
      const clickOutsideHouse = houseAlpha
        ? !isPointInsideAlpha(houseAlpha, width, height, opts.clickX, opts.clickY, 128)
        : false; // no AI house mask available — the boundary-aware flood fill is the only safeguard
      if (clickOutsideHouse || isMaskEmpty(maskImageData)) {
        logger.info('magic_wand.selection.rejected', { assetId: activeAssetId, hasHouseMask: !!houseAlpha });
        showToast('No selectable house region found.', { variant: 'danger' });
        return;
      }
      logger.info('magic_wand.selection.completed', {
        assetId: activeAssetId,
        selectionArea: countMaskPixels(maskImageData),
        tolerance: opts.tolerance,
        hasHouseMask: !!houseAlpha,
      });
    }

    // Mask-edit mode refines an *existing* layer's mask rather than
    // producing a new one (requirements doc, Section 5.2) — but only while
    // the pending color still matches what this layer is already painted.
    // A layer holds exactly one current_color_id, so if the dealer picked a
    // *different* color since this layer was last painted, an "add to mask"
    // stroke is a new paint operation (its own layer, its own color), not a
    // silent repaint of this layer's existing region — that silent repaint
    // was the reported color-bleed bug. Subtracting never introduces color,
    // so it's unaffected by this check.
    if (createdVia === 'brush' && opts.brushMode === 'mask-edit' && activeLayerId) {
      const activeLayer = layerList.find((l) => l.id === activeLayerId);
      const colorMismatch = isColorMismatch({ activeLayer, pendingColorId, subtract: opts.subtract });
      if (!colorMismatch) {
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
      // else: color changed since this layer was painted — fall through to
      // create a new layer below, carrying the newly selected color.
    }

    // Instant preview while the create request is in flight — there's no
    // layer id yet to key a localMaskOverrides entry by, so this renders
    // purely visually (see pendingNewLayer's declaration) until the real
    // layer exists.
    const previewColorRgb = pendingColorId ? colorLookup(pendingColorId) : null;
    setPendingNewLayer({ maskImageData, colorRgb: previewColorRgb });

    const startedAt = performance.now();
    logger.info('paint.stroke.persist.started', { createdVia });
    try {
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
      logger.info('paint.stroke.persist.completed', { layerId: layer.id, durationMs: Math.round(performance.now() - startedAt) });
    } catch (err) {
      logger.error('paint.stroke.persist.failed', { createdVia, message: err.message, durationMs: Math.round(performance.now() - startedAt) });
      showToast('Could not save this new layer — check your connection and try again.', { variant: 'danger' });
    } finally {
      // useCreateLayer's onSuccess writes the real layer straight into the
      // layers query cache (no extra refetch), so by the time this runs the
      // real LayerNode is already ready to take over — no visible gap
      // between clearing this preview and the real layer appearing.
      setPendingNewLayer(null);
    }
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
      undoPointer={undoPointer}
      onJumpTo={jumpToWithCache}
      onSelectAsset={setActiveAssetId}
      width={width}
      height={height}
    />
  );

  const inspector = (
    <Inspector
      projectId={projectId}
      assetId={activeAssetId}
      asset={activeAsset}
      colorLookup={colorLookup}
      baseImageData={baseImageData}
      width={width}
      height={height}
      onOpenExport={() => setShowExport(true)}
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
        <AiPipelineStatusChip assetId={activeAssetId} />
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
            houseAlpha={houseAlpha}
            onSurfacePick={handleSurfacePick}
            localMaskOverrides={localMaskOverrides}
            pendingNewLayer={pendingNewLayer}
            activeAssetId={activeAssetId}
          />
        </div>

        <div className="hidden xl:flex">
          {inspector}
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
            {inspector}
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
