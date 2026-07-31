import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import { paintCanvasRegion } from '../lib/colorEngine';

/**
 * Displays the working image and lets the user brush a mask over a surface
 * (e.g. "front wall"). All recoloring happens on-canvas in the browser —
 * nothing here is sent to the server for processing.
 */
const ImageCanvas = forwardRef(function ImageCanvas({ imageUrl, brushSize = 40 }, ref) {
  const displayCanvasRef = useRef(null); // what the user sees (image + live recolor)
  const baseCanvasRef = useRef(null);    // untouched pixels, kept so we can re-blend without drift
  const maskCanvasRef = useRef(null);    // off-screen mask (alpha = selection strength)
  const [drawing, setDrawing] = useState(false);
  const [dims, setDims] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!imageUrl) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const maxDim = 1600; // client-side downscale cap, keeps canvas ops fast
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const width = Math.round(img.width * scale);
      const height = Math.round(img.height * scale);
      setDims({ width, height });

      [displayCanvasRef, baseCanvasRef, maskCanvasRef].forEach((r) => {
        r.current.width = width;
        r.current.height = height;
      });

      const displayCtx = displayCanvasRef.current.getContext('2d');
      const baseCtx = baseCanvasRef.current.getContext('2d');
      displayCtx.drawImage(img, 0, 0, width, height);
      baseCtx.drawImage(img, 0, 0, width, height);
    };
    img.src = imageUrl;
  }, [imageUrl]);

  function getPos(e) {
    const rect = displayCanvasRef.current.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (dims.width / rect.width),
      y: (e.clientY - rect.top) * (dims.height / rect.height),
    };
  }

  function drawMaskDot(x, y) {
    const ctx = maskCanvasRef.current.getContext('2d');
    ctx.fillStyle = 'rgba(255,255,255,1)';
    ctx.beginPath();
    ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  function handleDown(e) { setDrawing(true); const { x, y } = getPos(e); drawMaskDot(x, y); }
  function handleMove(e) { if (!drawing) return; const { x, y } = getPos(e); drawMaskDot(x, y); }
  function handleUp() { setDrawing(false); }

  useImperativeHandle(ref, () => ({
    clearMask() {
      const ctx = maskCanvasRef.current.getContext('2d');
      ctx.clearRect(0, 0, dims.width, dims.height);
    },
    applyColor(targetRgb, strength = 0.85) {
      // Always blend from the untouched base so repeated color changes don't compound.
      const displayCtx = displayCanvasRef.current.getContext('2d');
      displayCtx.drawImage(baseCanvasRef.current, 0, 0);
      paintCanvasRegion(displayCanvasRef.current, maskCanvasRef.current, targetRgb, strength);
    },
    setBaseImage(dataUrlOrCanvas) {
      // Used after AI cleanup returns a new image — replace the working base.
      const baseCtx = baseCanvasRef.current.getContext('2d');
      const displayCtx = displayCanvasRef.current.getContext('2d');
      const img = new Image();
      img.onload = () => {
        baseCtx.clearRect(0, 0, dims.width, dims.height);
        baseCtx.drawImage(img, 0, 0, dims.width, dims.height);
        displayCtx.drawImage(img, 0, 0, dims.width, dims.height);
      };
      img.src = dataUrlOrCanvas;
    },
    exportPng() {
      return new Promise((resolve) => displayCanvasRef.current.toBlob(resolve, 'image/png'));
    },
    getDims: () => dims,
  }));

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <canvas
        ref={displayCanvasRef}
        onMouseDown={handleDown}
        onMouseMove={handleMove}
        onMouseUp={handleUp}
        onMouseLeave={handleUp}
        style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid var(--line)', cursor: 'crosshair', display: 'block' }}
      />
      <canvas ref={baseCanvasRef} style={{ display: 'none' }} />
      <canvas ref={maskCanvasRef} style={{ display: 'none' }} />
    </div>
  );
});

export default ImageCanvas;
