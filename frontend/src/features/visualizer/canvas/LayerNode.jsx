import { useEffect, useState } from 'react';
import { Image as KonvaImage } from 'react-konva';
import { applyPaintColor } from '../../../shared/lib/colorEngine';
import { canvasFromImageData, drawToImageData } from '../../../shared/lib/canvas';
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

    // Coalesce to one recompute per animation frame — catalog hover-preview
    // can fire this effect many times a second as the pointer crosses
    // swatches, and the LAB pixel pass is the most expensive thing this
    // component does. A same-frame superseding update cancels the stale one
    // before it ever runs, so only the latest color actually gets computed.
    const rafId = requestAnimationFrame(() => {
      const maskData = drawToImageData(maskImage, width, height);

      const targetRgb = colorRgb || PREVIEW_TINT;
      // Painted layers get near-full pigment coverage that re-anchors the
      // region onto the paint's own lightness while keeping relative shading;
      // the unpainted preview stays a soft, lightness-neutral wash.
      const painted = !!colorRgb;
      const strength = painted ? 0.95 : 0.35;
      const result = applyPaintColor(baseImageData, maskData, targetRgb, strength, {
        transparentOutsideMask: true,
        lightnessBlend: painted ? 0.45 : 0,
      });

      setBitmap(canvasFromImageData(result));
    });

    return () => cancelAnimationFrame(rafId);
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
