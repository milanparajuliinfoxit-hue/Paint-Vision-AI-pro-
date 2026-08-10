import { useEffect, useState } from 'react';
import { Image as KonvaImage } from 'react-konva';
import { applyPaintColor, PAINT_STRENGTH, PAINT_LIGHTNESS_BLEND } from '../../../shared/lib/colorEngine';
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
//
// `localMaskData` (optional, a raw ImageData) lets the caller feed a mask
// that was just computed in memory — mid-stroke or right after a commit —
// straight into compositing, skipping maskUrl/useImageElement's network
// fetch + decode entirely. Without this, every paint/erase stroke's visible
// result had to wait for a mask PNG upload, a layers-list refetch, AND a
// second fetch of the newly-uploaded PNG before anything on screen changed
// — three sequential network round trips gating a result that was already
// sitting in memory. `localMaskData` takes priority over `maskUrl` whenever
// both are present; the caller is responsible for clearing it once the
// server-confirmed state (maskUrl) has caught up, so a later reload or a
// change from elsewhere still goes through the normal network path.
export default function LayerNode({ layer, baseImageData, width, height, colorRgb, maskUrl, localMaskData }) {
  const [bitmap, setBitmap] = useState(null);
  const { image: maskImage } = useImageElement(localMaskData ? null : maskUrl);

  useEffect(() => {
    if (!baseImageData || !width || !height) return;
    if (!localMaskData && !maskImage) return;

    // Coalesce to one recompute per animation frame — catalog hover-preview
    // can fire this effect many times a second as the pointer crosses
    // swatches, and the LAB pixel pass is the most expensive thing this
    // component does. A same-frame superseding update cancels the stale one
    // before it ever runs, so only the latest color actually gets computed.
    const rafId = requestAnimationFrame(() => {
      let maskData;
      if (localMaskData) {
        // Already a full-size ImageData in memory — no canvas draw/decode
        // needed at all, unlike the maskUrl path below.
        maskData = localMaskData;
      } else {
        const maskCanvas = document.createElement('canvas');
        maskCanvas.width = width;
        maskCanvas.height = height;
        const maskCtx = maskCanvas.getContext('2d');
        maskCtx.drawImage(maskImage, 0, 0, width, height);
        maskData = maskCtx.getImageData(0, 0, width, height);
      }

      const targetRgb = colorRgb || PREVIEW_TINT;
      // Painted layers get near-full pigment coverage that re-anchors the
      // region onto the paint's own lightness while keeping relative shading;
      // the unpainted preview stays a soft, lightness-neutral wash.
      const painted = !!colorRgb;
      const strength = painted ? PAINT_STRENGTH : 0.35;
      const result = applyPaintColor(baseImageData, maskData, targetRgb, strength, {
        transparentOutsideMask: true,
        lightnessBlend: painted ? PAINT_LIGHTNESS_BLEND : 0,
      });

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').putImageData(result, 0, 0);
      setBitmap(canvas);
    });

    return () => cancelAnimationFrame(rafId);
  }, [baseImageData, maskImage, localMaskData, width, height, colorRgb?.r, colorRgb?.g, colorRgb?.b]);

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
