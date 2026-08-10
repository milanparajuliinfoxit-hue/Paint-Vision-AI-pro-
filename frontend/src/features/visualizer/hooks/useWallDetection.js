import { useState, useCallback } from 'react';
import { ai } from '../../../shared/lib/api';
import { useVisualizerStore } from '../store/visualizerStore';
import { useToast } from '../../../shared/ui/toast';
import { logger } from '../../../shared/lib/logger';

/**
 * Custom hook to handle point-click AI wall detection & segmentation calls.
 */
export function useWallDetection(assetId) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const showToast = useToast();

  const setAiWallActiveMask = useVisualizerStore((s) => s.setAiWallActiveMask);
  const setAiWallIsSegmenting = useVisualizerStore((s) => s.setAiWallIsSegmenting);
  const setInProgressMaskCanvas = useVisualizerStore((s) => s.setInProgressMaskCanvas);
  const positivePoints = useVisualizerStore((s) => s.aiWallPositivePoints);
  const negativePoints = useVisualizerStore((s) => s.aiWallNegativePoints);
  const activeMaskCanvas = useVisualizerStore((s) => s.aiWallActiveMask);

  const segmentWall = useCallback(
    async ({ x, y, mode = 'new', existingMaskCanvas = null }) => {
      if (!assetId) {
        showToast('Please select a photo asset first.', 'warn');
        return null;
      }

      setLoading(true);
      setAiWallIsSegmenting(true);
      setError(null);

      try {
        const res = await ai.segmentWall(assetId, {
          x,
          y,
          positivePoints,
          negativePoints,
          mode,
        });

        if (!res || !res.alphaBase64) {
          throw new Error('No mask data received from wall detection service.');
        }

        // Convert base64 alpha to Uint8Array and paint onto an offscreen canvas
        const binaryStr = atob(res.alphaBase64);
        const len = binaryStr.length;
        const alphaBytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          alphaBytes[i] = binaryStr.charCodeAt(i);
        }

        const width = res.width || 800;
        const height = res.height || 600;

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        const imgData = ctx.createImageData(width, height);

        // Fill ImageData: black mask with alpha channel representing selection strength
        for (let i = 0; i < alphaBytes.length; i++) {
          const a = alphaBytes[i];
          const pxIdx = i * 4;
          imgData.data[pxIdx] = 0;
          imgData.data[pxIdx + 1] = 0;
          imgData.data[pxIdx + 2] = 0;
          imgData.data[pxIdx + 3] = a;
        }

        ctx.putImageData(imgData, 0, 0);

        let finalCanvas = canvas;
        if (mode === 'add' && (existingMaskCanvas || activeMaskCanvas)) {
          const base = existingMaskCanvas || activeMaskCanvas;
          const merged = document.createElement('canvas');
          merged.width = width;
          merged.height = height;
          const mCtx = merged.getContext('2d');
          mCtx.drawImage(base, 0, 0);
          mCtx.globalCompositeOperation = 'lighter';
          mCtx.drawImage(canvas, 0, 0);
          finalCanvas = merged;
        }

        setAiWallActiveMask(finalCanvas);
        setInProgressMaskCanvas(finalCanvas);
        showToast('Wall surface detected successfully!', 'success');
        return finalCanvas;
      } catch (err) {
        logger.error('wall_segmentation.failed', { assetId, x, y, message: err.message });
        setError(err.message);
        showToast('Could not auto-detect wall surface. You can refine or use manual tools.', 'error');
        return null;
      } finally {
        setLoading(false);
        setAiWallIsSegmenting(false);
      }
    },
    [assetId, positivePoints, negativePoints, activeMaskCanvas, setAiWallActiveMask, setAiWallIsSegmenting, setInProgressMaskCanvas, showToast]
  );

  return {
    segmentWall,
    loading,
    error,
  };
}
