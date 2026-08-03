import { useEffect, useState } from 'react';
import { Image as KonvaImage } from 'react-konva';
import { applyPaintColor } from '../../../shared/lib/colorEngine';
import { useImageElement } from './useImageElement';

const PREVIEW_TINT = { r: 47, g: 93, b: 138 }; // --signal, used only for the unpainted mask preview

// One masked, re-colorable surface region. Recompute only runs when this
// layer's own mask or color changes — not on every store update — so
// swapping a color re-renders a single layer instead of the whole stage
// (requirements doc, Section 5.2/14).
//
// A fresh <canvas> is allocated per recompute (rather than mutating one in
// place) so the new bitmap is always a distinct object reference — Konva's
// Image node redraws off prop changes, not off pixel contents, so mutating
// a canvas in place is not guaranteed to repaint the stage.
export default function LayerNode({ layer, baseImageData, width, height, colorRgb, maskUrl }) {
  const [bitmap, setBitmap] = useState(null);
  const { image: maskImage } = useImageElement(maskUrl);

  useEffect(() => {
    if (!baseImageData || !maskImage || !width || !height) return;

    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = width;
    maskCanvas.height = height;
    const maskCtx = maskCanvas.getContext('2d');
    maskCtx.drawImage(maskImage, 0, 0, width, height);
    const maskData = maskCtx.getImageData(0, 0, width, height);

    const targetRgb = colorRgb || PREVIEW_TINT;
    const strength = colorRgb ? 0.85 : 0.35; // unpainted layers get a soft preview wash, not a full recolor
    const result = applyPaintColor(baseImageData, maskData, targetRgb, strength, { transparentOutsideMask: true });

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').putImageData(result, 0, 0);
    setBitmap(canvas);
  }, [baseImageData, maskImage, width, height, colorRgb?.r, colorRgb?.g, colorRgb?.b]);

  if (!bitmap || !layer.visible) return null;

  return (
    <KonvaImage
      image={bitmap}
      width={width}
      height={height}
      opacity={Number(layer.opacity ?? 1)}
      listening={false}
    />
  );
}
