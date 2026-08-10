import { useEffect, useRef, useState } from 'react';
import { Stage, Layer, Image as KonvaImage, Rect, Line, Circle } from 'react-konva';
import LayerNode from './LayerNode';
import { useToolInteraction } from '../tools/useToolInteraction';
import { useVisualizerStore } from '../store/visualizerStore';
import { Button } from '../../../shared/ui/button';
import { assets } from '../../../shared/lib/api';

export default function CanvasStage({
  baseImage,
  baseImageData,
  width,
  height,
  loading,
  error,
  layers,
  colorLookup,
  onCommitMask,
  onEyedropper,
  constraintAlpha,
  surfaceMasks,
  houseAlpha,
  onSurfacePick,
  localMaskOverrides,
  pendingNewLayer,
}) {
  const containerRef = useRef(null);
  const stageRef = useRef(null);
  const [containerSize, setContainerSize] = useState({ width: 800, height: 600 });
  const [spaceDown, setSpaceDown] = useState(false);
  const [hoverPos, setHoverPos] = useState(null);

  const activeTool = useVisualizerStore((s) => s.activeTool);
  const brushSize = useVisualizerStore((s) => s.brushSize);
  const surfaceAware = useVisualizerStore((s) => s.surfaceAware);
  const viewport = useVisualizerStore((s) => s.viewport);
  const setViewport = useVisualizerStore((s) => s.setViewport);
  const activeLayerId = useVisualizerStore((s) => s.activeLayerId);
  const hoverPreviewColorRgb = useVisualizerStore((s) => s.hoverPreviewColorRgb);
  const imageLocked = useVisualizerStore((s) => s.imageLocked);
  const imageVisible = useVisualizerStore((s) => s.imageVisible);
  const fitSignal = useVisualizerStore((s) => s.fitSignal);

  const tool = useToolInteraction({ width, height, baseImageData, onCommitMask, onEyedropper, constraintAlpha, surfaceMasks, onSurfacePick, houseAlpha });

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setContainerSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Fit-to-screen once the image first loads, and again whenever a fit is
  // requested from the outside (e.g. toolbar "fit to screen").
  useEffect(() => {
    if (width && height && containerSize.width) fitToScreen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height, fitSignal]);

  useEffect(() => {
    function onKeyDown(e) {
      if (e.code === 'Space') setSpaceDown(true);
      if (e.key === 'Escape') tool.cancel();
      if (e.key === 'Enter' && activeTool === 'polygon') tool.commitPolygon();
    }
    function onKeyUp(e) {
      if (e.code === 'Space') setSpaceDown(false);
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [activeTool, tool]);

  function fitToScreen() {
    if (!width || !height || imageLocked) return;
    const scale = Math.min(containerSize.width / width, containerSize.height / height, 1) * 0.95;
    setViewport({
      scale,
      x: (containerSize.width - width * scale) / 2,
      y: (containerSize.height - height * scale) / 2,
    });
  }

  function zoom100() {
    if (imageLocked) return;
    setViewport({ scale: 1, x: (containerSize.width - width) / 2, y: (containerSize.height - height) / 2 });
  }

  function toImageSpace(stagePointer) {
    return {
      x: (stagePointer.x - viewport.x) / viewport.scale,
      y: (stagePointer.y - viewport.y) / viewport.scale,
    };
  }

  function handleWheel(e) {
    e.evt.preventDefault();
    if (imageLocked) return;
    if (!e.evt.ctrlKey && !e.evt.metaKey) return; // plain scroll is a no-op — only ctrl/cmd+scroll zooms
    const stage = stageRef.current;
    const pointer = stage.getPointerPosition();
    const oldScale = viewport.scale;
    const direction = e.evt.deltaY > 0 ? -1 : 1;
    const newScale = Math.min(8, Math.max(0.1, oldScale * (1 + direction * 0.08)));

    const mousePointTo = { x: (pointer.x - viewport.x) / oldScale, y: (pointer.y - viewport.y) / oldScale };
    setViewport({
      scale: newScale,
      x: pointer.x - mousePointTo.x * newScale,
      y: pointer.y - mousePointTo.y * newScale,
    });
  }

  const draggableStage = (spaceDown || activeTool === 'pan') && !imageLocked;
  const cursor = draggableStage ? 'grab' : 'crosshair';

  function stagePointerHandler(handler) {
    return (e) => {
      if (draggableStage) return;
      const pointer = e.target.getStage().getPointerPosition();
      handler(toImageSpace(pointer), e.evt);
    };
  }

  // Tracked independent of whether a stroke is in progress, purely so the
  // brush/eraser size cursor below can follow the pointer at rest — the
  // tool interaction hook only cares about points once a drag has started.
  const handleHoverMove = stagePointerHandler((pt, evt) => {
    setHoverPos(pt);
    tool.handlePointerMove(pt, evt);
  });
  const showBrushCursor = (activeTool === 'brush' || activeTool === 'eraser') && hoverPos && !draggableStage;

  const showStage = width > 0 && height > 0 && baseImage;

  return (
    <div ref={containerRef} className="checkerboard relative flex-1 h-full overflow-hidden" style={{ cursor }}>
      {/* Loading skeleton — quiet shimmer instead of a text flash */}
      {loading && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-[var(--ink-soft)]/80">
          <div className="flex flex-col items-center gap-3 fade-in">
            <div className="skeleton h-6 w-6 rounded-full" />
            <div className="skeleton h-3 w-32 rounded" />
            <div className="text-xs text-white/50">Loading photo…</div>
          </div>
        </div>
      )}

      {/* Image failed to load — say so clearly instead of a silent blank canvas */}
      {!loading && error && (
        <div className="absolute inset-0 z-20 flex items-center justify-center">
          <div className="rise-in flex max-w-sm flex-col items-center gap-3 rounded-xl border border-[var(--danger)]/30 bg-[var(--paper-raised)] px-8 py-6 text-center shadow-xl">
            <div className="text-2xl">🖼️</div>
            <div className="font-semibold text-[var(--graphite-dark)]">Photo couldn't be loaded</div>
            <div className="text-sm text-[var(--graphite)]">
              The image file is missing or unreadable. Re-upload the photo to restore this asset.
            </div>
            <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>Retry</Button>
          </div>
        </div>
      )}

      {/* No image to show at all — inviting empty state, not a void */}
      {!loading && !error && !showStage && (
        <div className="absolute inset-0 z-20 flex items-center justify-center">
          <div className="rise-in flex flex-col items-center gap-3 px-8 text-center text-white/70">
            <div className="text-3xl">🖼️</div>
            <div className="font-semibold text-white/85">No photo yet</div>
            <div className="max-w-xs text-sm text-white/55">
              Upload a photo of the room you want to paint — it will appear here, ready for
              masking, color fills and AI surfaces.
            </div>
          </div>
        </div>
      )}

      {showStage && (
        <Stage
          ref={stageRef}
          width={containerSize.width}
          height={containerSize.height}
          scaleX={viewport.scale}
          scaleY={viewport.scale}
          x={viewport.x}
          y={viewport.y}
          draggable={draggableStage}
          onDragEnd={(e) => setViewport({ ...viewport, x: e.target.x(), y: e.target.y() })}
          onWheel={handleWheel}
          onMouseDown={stagePointerHandler(tool.handlePointerDown)}
          onMouseMove={handleHoverMove}
          onMouseUp={stagePointerHandler(() => tool.handlePointerUp())}
          onMouseLeave={() => setHoverPos(null)}
          onDblClick={() => activeTool === 'polygon' && tool.commitPolygon()}
        >
          <Layer listening={false}>
            {imageVisible && baseImage && <KonvaImage image={baseImage} width={width} height={height} />}
            {[...(layers || [])]
              .sort((a, b) => a.order_index - b.order_index)
              .map((layer) => (
                <LayerNode
                  key={layer.id}
                  layer={layer}
                  baseImageData={baseImageData}
                  width={width}
                  height={height}
                  colorRgb={layer.id === activeLayerId && hoverPreviewColorRgb ? hoverPreviewColorRgb : colorLookup?.(layer.current_color_id)}
                  maskUrl={layer.mask_path ? assets.fileUrl(layer.mask_path) : null}
                  localMaskData={localMaskOverrides?.get(layer.id)}
                />
              ))}
            {/* A new layer's mask is ready before the create request that
                gives it a real id resolves — render it immediately, on top
                (it's the newest thing painted), purely visually until the
                real LayerNode above takes over. */}
            {pendingNewLayer && (
              <LayerNode
                key="pending-new-layer"
                layer={{ id: 'pending-new-layer', visible: true, opacity: 1 }}
                baseImageData={baseImageData}
                width={width}
                height={height}
                colorRgb={pendingNewLayer.colorRgb}
                maskUrl={null}
                localMaskData={pendingNewLayer.maskImageData}
              />
            )}
          </Layer>

          {/* Live tool-preview overlay — pure Konva shapes, no pixel work until commit. */}
          <Layer>
            {activeTool === 'rect' && tool.dragStart && tool.dragCurrent && (
              <Rect
                x={Math.min(tool.dragStart.x, tool.dragCurrent.x)}
                y={Math.min(tool.dragStart.y, tool.dragCurrent.y)}
                width={Math.abs(tool.dragCurrent.x - tool.dragStart.x)}
                height={Math.abs(tool.dragCurrent.y - tool.dragStart.y)}
                stroke="#2f5d8a"
                dash={[6, 4]}
                strokeWidth={2 / viewport.scale}
              />
            )}
            {(activeTool === 'lasso' || activeTool === 'polygon') && tool.polygonPoints.length > 1 && (
              <Line
                points={tool.polygonPoints.flatMap((p) => [p.x, p.y])}
                stroke="#2f5d8a"
                strokeWidth={2 / viewport.scale}
                closed={activeTool === 'lasso'}
                dash={[6, 4]}
              />
            )}
            {(activeTool === 'brush' || activeTool === 'eraser') && tool.brushPoints.length > 0 && (
              <Line
                points={tool.brushPoints.flatMap((p) => [p.x, p.y])}
                stroke={activeTool === 'eraser' ? 'rgba(200,60,60,0.55)' : 'rgba(47,93,138,0.6)'}
                strokeWidth={brushSize}
                lineCap="round"
                lineJoin="round"
                tension={0.4}
                opacity={activeTool === 'brush' && surfaceAware && baseImageData ? 0 : 1}
              />
            )}
            {/* Surface-aware live preview — the actual constrained fill, so
                the user sees the wall-clipped paint while dragging instead
                of a raw path that suggests it will cross railings. */}
            {activeTool === 'brush' && surfaceAware && tool.isDrawing && tool.previewCanvas && (
              <KonvaImage image={tool.previewCanvas} width={width} height={height} listening={false} opacity={0.92} />
            )}
            {showBrushCursor && (
              <Circle
                x={hoverPos.x}
                y={hoverPos.y}
                radius={brushSize / 2}
                stroke={activeTool === 'eraser' ? 'rgba(200,60,60,0.9)' : 'rgba(47,93,138,0.9)'}
                strokeWidth={1.5 / viewport.scale}
                listening={false}
              />
            )}
          </Layer>
        </Stage>
      )}

      <div className="absolute bottom-3 right-3 flex items-center gap-2 rounded-full border border-white/10 bg-[var(--ink)]/80 px-3 py-1.5 backdrop-blur">
        <Button size="sm" variant="ghost" className="text-white/85" onClick={fitToScreen}>Fit</Button>
        <span className="h-3 w-px bg-white/15" />
        <Button size="sm" variant="ghost" className="text-white/85" onClick={zoom100}>100%</Button>
        <span className="h-3 w-px bg-white/15" />
        <span className="text-xs tabular-nums text-white/70">{Math.round(viewport.scale * 100)}%</span>
      </div>
    </div>
  );
}
