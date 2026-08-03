import { useState } from 'react';
import { useVisualizerStore } from '../store/visualizerStore';
import { rasterizeRect, rasterizePolygon, rasterizeBrushStroke, floodFillMask } from './maskOps';
import { rgbToLab } from '../../../shared/lib/colorEngine';

// Owns the transient, in-progress interaction for whichever tool is active
// (drag rect, lasso path, polygon points, brush stroke). Selection tools all
// resolve to a finished mask handed to onCommitMask — nothing paints
// directly except bucket fill (requirements doc, Section 5.2).
export function useToolInteraction({ width, height, baseImageData, onCommitMask, onBucketFill, onEyedropper }) {
  const activeTool = useVisualizerStore((s) => s.activeTool);
  const brushMode = useVisualizerStore((s) => s.brushMode);
  const brushSize = useVisualizerStore((s) => s.brushSize);
  const magicWandTolerance = useVisualizerStore((s) => s.magicWandTolerance);

  const [dragStart, setDragStart] = useState(null);
  const [dragCurrent, setDragCurrent] = useState(null);
  const [polygonPoints, setPolygonPoints] = useState([]);
  const [brushPoints, setBrushPoints] = useState([]);
  const [subtractStroke, setSubtractStroke] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);

  function reset() {
    setDragStart(null);
    setDragCurrent(null);
    setPolygonPoints([]);
    setBrushPoints([]);
    setSubtractStroke(false);
    setIsDrawing(false);
  }

  function handlePointerDown(pt, evt) {
    if (!width || !height) return;
    switch (activeTool) {
      case 'rect':
        setDragStart(pt); setDragCurrent(pt); setIsDrawing(true);
        break;
      case 'lasso':
        setIsDrawing(true); setPolygonPoints([pt]);
        break;
      case 'polygon':
        setPolygonPoints((prev) => [...prev, pt]);
        break;
      case 'brush':
      case 'eraser':
        setIsDrawing(true);
        setBrushPoints([pt]);
        setSubtractStroke(!!evt?.altKey);
        break;
      case 'magic-wand': {
        if (!baseImageData) return;
        const x = Math.min(width - 1, Math.max(0, Math.round(pt.x)));
        const y = Math.min(height - 1, Math.max(0, Math.round(pt.y)));
        const mask = floodFillMask(baseImageData, x, y, magicWandTolerance, rgbToLab);
        onCommitMask(mask, 'magic-wand', {});
        break;
      }
      case 'bucket':
        onBucketFill?.();
        break;
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
    if (activeTool === 'brush' || activeTool === 'eraser') setBrushPoints((prev) => [...prev, pt]);
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
    } else if (activeTool === 'eraser' && brushPoints.length > 0) {
      const strokeMask = rasterizeBrushStroke(width, height, brushPoints, brushSize);
      onCommitMask(strokeMask, 'eraser', {});
      reset();
    } else if (activeTool === 'brush' && brushPoints.length > 0) {
      const strokeMask = rasterizeBrushStroke(width, height, brushPoints, brushSize);
      onCommitMask(strokeMask, 'brush', { brushMode, subtract: subtractStroke });
      reset();
    } else {
      setIsDrawing(false);
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
    isDrawing,
  };
}
