import { useRef, useState } from 'react';
import { useVisualizerStore } from '../store/visualizerStore';
import { rasterizeRect, rasterizePolygon, rasterizeBrushStroke, surfaceAwareBrushStroke, floodFillMask, floodFillMaskDebug, maskToPreviewDataUrl, clipMaskToConstraint, pickSurfaceAtPoint } from './maskOps';
import { rgbToLab } from '../../../shared/lib/colorEngine';

// Owns the transient, in-progress interaction for whichever tool is active
// (drag rect, lasso path, polygon points, brush stroke). Selection tools all
// resolve to a finished mask handed to onCommitMask (requirements doc,
// Section 5.2); color application itself happens on catalog click
// (useApplyColor), not through a canvas tool.
//
// `constraintAlpha` (optional Uint8Array, full image size) clips brush
// strokes to an AI-detected surface mask — the surface lock — so paint on an
// ai-surface layer physically cannot escape the detected surface.
//
// `surfaceMasks` (from useSurfaceAlphaGrids) backs the surface-pick tool: a
// click resolves to the paintable surface under the cursor and is handed to
// onSurfacePick, which paints the whole surface as an idempotent AI layer.
// `houseAlpha` (optional Uint8Array, full image size) is the union of every
// AI-detected surface's mask — when present, Magic Wand's flood fill can
// never cross outside it, however close the colors are on either side
// (house-aware selection). Absent when no analysis has been run yet; the
// tool still falls back to its own boundary-aware color/step tolerance.
export function useToolInteraction({
  width, height, baseImageData, onCommitMask, onEyedropper, constraintAlpha, surfaceMasks, onSurfacePick, houseAlpha,
}) {
  const activeTool = useVisualizerStore((s) => s.activeTool);
  const brushMode = useVisualizerStore((s) => s.brushMode);
  const brushSize = useVisualizerStore((s) => s.brushSize);
  const magicWandTolerance = useVisualizerStore((s) => s.magicWandTolerance);
  const magicWandFeather = useVisualizerStore((s) => s.magicWandFeather);
  const magicWandDebugEnabled = useVisualizerStore((s) => s.magicWandDebugEnabled);
  const setMagicWandDebug = useVisualizerStore((s) => s.setMagicWandDebug);
  const surfaceAware = useVisualizerStore((s) => s.surfaceAware);
  const surfaceTolerance = useVisualizerStore((s) => s.surfaceTolerance);
  const maskRefineMode = useVisualizerStore((s) => s.maskRefineMode);

  const [dragStart, setDragStart] = useState(null);
  const [dragCurrent, setDragCurrent] = useState(null);
  const [polygonPoints, setPolygonPoints] = useState([]);
  const [brushPoints, setBrushPoints] = useState([]);
  const [subtractStroke, setSubtractStroke] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  // Canvas the surface-aware brush renders its constrained fill into so the
  // user sees exactly what will be painted *while* dragging, not after.
  const [previewCanvas, setPreviewCanvas] = useState(null);

  const lastPreviewAt = useRef(0);
  const windowUpRef = useRef(null);
  // Mutable mirror of the in-progress stroke so preview/commit always see
  // the *latest* points synchronously (state would lag one render behind a
  // fast drag), while `brushPoints` state drives the Konva preview overlay.
  const brushPointsRef = useRef([]);

  function reset() {
    setDragStart(null);
    setDragCurrent(null);
    setPolygonPoints([]);
    brushPointsRef.current = [];
    setBrushPoints([]);
    setSubtractStroke(false);
    setIsDrawing(false);
    setPreviewCanvas(null);
    if (windowUpRef.current) {
      window.removeEventListener('mouseup', windowUpRef.current);
      windowUpRef.current = null;
    }
  }

  // Strokes must not get stuck if the pointer is released outside the Stage
  // (a fast flick off the canvas edge). A window-level mouseup finalizes the
  // stroke regardless; it self-removes, and reset() also removes it so an
  // in-canvas release (handled by the Stage's onMouseUp) never double-fires.
  function armWindowUp() {
    if (windowUpRef.current) return;
    const fn = () => {
      window.removeEventListener('mouseup', fn);
      windowUpRef.current = null;
      handlePointerUp();
    };
    windowUpRef.current = fn;
    window.addEventListener('mouseup', fn);
  }

  // Throttled live preview of the surface-aware brush: recompute the
  // constrained fill at most a handful of times a second while dragging.
  // Cheap for typical strokes (the fill stays inside the stroke's bbox), and
  // large strokes fall back to the raw path preview rather than jank the drag.
  function refreshPreview(nextPoints) {
    if (!surfaceAware || !baseImageData || nextPoints.length < 2) return;
    const now = performance.now();
    if (now - lastPreviewAt.current < 150) return;
    lastPreviewAt.current = now;
    let mask = surfaceAwareBrushStroke(baseImageData, width, height, nextPoints, brushSize, surfaceTolerance, rgbToLab);
    if (constraintAlpha) mask = clipMaskToConstraint(mask, constraintAlpha);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').putImageData(mask, 0, 0);
    setPreviewCanvas(canvas);
  }

  function handlePointerDown(pt, evt) {
    if (!width || !height) return;
    switch (activeTool) {
      case 'rect':
        setDragStart(pt); setDragCurrent(pt); setIsDrawing(true); armWindowUp();
        break;
      case 'lasso':
        setIsDrawing(true); setPolygonPoints([pt]); armWindowUp();
        break;
      case 'polygon':
        setPolygonPoints((prev) => [...prev, pt]);
        break;
      case 'brush':
      case 'eraser':
        setIsDrawing(true);
        brushPointsRef.current = [pt];
        setBrushPoints([pt]);
        setSubtractStroke(maskRefineMode === 'remove' ? !evt?.altKey : !!evt?.altKey);
        lastPreviewAt.current = 0;
        armWindowUp();
        break;
      case 'surface-pick': {
        const surface = pickSurfaceAtPoint(surfaceMasks, pt.x, pt.y);
        if (surface) onSurfacePick?.(surface);
        break;
      }
      case 'magic-wand': {
        if (!baseImageData) return;
        const x = Math.min(width - 1, Math.max(0, Math.round(pt.x)));
        const y = Math.min(height - 1, Math.max(0, Math.round(pt.y)));
        const floodOpts = { houseAlpha, featherPx: magicWandFeather };
        let mask;
        if (magicWandDebugEnabled) {
          const stages = floodFillMaskDebug(baseImageData, x, y, magicWandTolerance, rgbToLab, floodOpts);
          mask = stages.mask;
          setMagicWandDebug({
            raw: maskToPreviewDataUrl(stages.raw),
            closed: maskToPreviewDataUrl(stages.closed),
            final: maskToPreviewDataUrl(stages.final),
          });
        } else {
          mask = floodFillMask(baseImageData, x, y, magicWandTolerance, rgbToLab, floodOpts);
        }
        // clickX/clickY let handleCommitMask independently validate the click
        // itself landed on the house (Section 12) — not just that some mask
        // came back non-empty. tolerance is passed through purely for logging.
        onCommitMask(mask, 'magic-wand', { clickX: x, clickY: y, tolerance: magicWandTolerance });
        break;
      }
      case 'eyedropper':
        onEyedropper?.(pt);
        break;
      default:
        break;
    }
  }

  function handlePointerMove(pt) {
    if (!isDrawing) return;
    if (activeTool === 'rect') setDragCurrent(pt);
    if (activeTool === 'lasso') setPolygonPoints((prev) => [...prev, pt]);
    if (activeTool === 'brush' || activeTool === 'eraser') {
      brushPointsRef.current.push(pt);
      setBrushPoints([...brushPointsRef.current]);
      if (activeTool === 'brush') refreshPreview(brushPointsRef.current);
    }
  }

  function handlePointerUp() {
    if (activeTool === 'rect' && dragStart && dragCurrent) {
      const mask = rasterizeRect(width, height, dragStart.x, dragStart.y, dragCurrent.x, dragCurrent.y);
      onCommitMask(mask, 'rect', {});
      reset();
    } else if (activeTool === 'lasso' && polygonPoints.length > 2) {
      const mask = rasterizePolygon(width, height, polygonPoints);
      onCommitMask(mask, 'lasso', {});
      reset();
    } else if (activeTool === 'eraser' && brushPointsRef.current.length > 0) {
      // feather: 0 — a feathered stroke never reaches full (255) alpha right
      // at its own edge, so subtracting it can never zero out a layer's mask
      // no matter how thoroughly the user drags over it: the emptiness check
      // downstream (isMaskEmpty) would keep finding a faint residual rim
      // forever, and the layer would never auto-delete even when the erase
      // is visually complete. A full-strength stroke has no such floor —
      // subtracting 255 from any existing alpha always reaches exactly 0
      // wherever it's dragged, regardless of how soft the *painted* mask's
      // own edges are (surfaceAwareBrushStroke already uses the same
      // feather: 0 footprint for an unrelated reason; same parameter, this
      // is just a second real use for it).
      const strokeMask = rasterizeBrushStroke(width, height, brushPointsRef.current, brushSize, { feather: 0 });
      onCommitMask(strokeMask, 'eraser', {});
      reset();
    } else if (activeTool === 'brush' && brushPointsRef.current.length > 0) {
      // The surface-aware brush clips the footprint to the wall under the
      // stroke; toggling it off restores the raw footprint for fine work.
      let strokeMask = surfaceAware && baseImageData
        ? surfaceAwareBrushStroke(baseImageData, width, height, brushPointsRef.current, brushSize, surfaceTolerance, rgbToLab)
        : rasterizeBrushStroke(width, height, brushPointsRef.current, brushSize);
      if (constraintAlpha) strokeMask = clipMaskToConstraint(strokeMask, constraintAlpha);
      onCommitMask(strokeMask, 'brush', { brushMode, subtract: subtractStroke });
      reset();
    } else {
      setIsDrawing(false);
      setPreviewCanvas(null);
    }
  }

  // Polygon tool commits explicitly (double-click / Enter), not on pointer up.
  function commitPolygon() {
    if (polygonPoints.length > 2) {
      const mask = rasterizePolygon(width, height, polygonPoints);
      onCommitMask(mask, 'polygon', {});
    }
    reset();
  }

  function cancel() {
    reset();
  }

  return {
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    commitPolygon,
    cancel,
    dragStart,
    dragCurrent,
    polygonPoints,
    brushPoints,
    previewCanvas,
    isDrawing,
  };
}
