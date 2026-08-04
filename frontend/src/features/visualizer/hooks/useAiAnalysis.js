import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ai, assets as assetsApi, meta } from '../../../shared/lib/api';

// Feature-flag/provider state from GET /api/meta — the UI renders capability
// toggles (enabled/disabled) based on the server's actual configuration.
export function useAiMeta() {
  return useQuery({ queryKey: ['meta'], queryFn: () => meta.get(), staleTime: 60_000 });
}

// Latest successful house-understanding for an asset (or an empty,
// analyzed:false shape before any run). Surfaces/objects carry mask_path,
// paintable flags, confidence, geometry, average color.
export function useAssetAnalysis(assetId) {
  return useQuery({
    queryKey: ['ai-analysis', assetId],
    queryFn: () => ai.getAnalysis(assetId),
    enabled: !!assetId,
  });
}

// Triggers a (re)analysis — POST runs the configured provider server-side and
// persists the versioned job + masks; success invalidates analysis AND
// recommendations (a new understanding invalidates old schemes).
export function useAnalyzeAsset(assetId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => ai.analyze(assetId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ai-analysis', assetId] });
      queryClient.invalidateQueries({ queryKey: ['ai-recommendations', assetId] });
    },
  });
}

// Upscaled alpha grid (Uint8Array, length width*height) of a detected
// surface's mask, drawn at the canvas' full resolution. Used as the brush
// constraint (surface lock) and for mask previews. Returns null while
// loading / when there's nothing to constrain to.
export function useSurfaceConstraintAlpha({ analysis, surfaceKey, width, height }) {
  const [alpha, setAlpha] = useState(null);

  useEffect(() => {
    setAlpha(null);
    if (!surfaceKey || !width || !height) return undefined;
    const surface = analysis?.surfaces?.find((s) => s.class_key === surfaceKey);
    if (!surface?.mask_path) return undefined;

    let cancelled = false;
    loadAlphaGrid(assetsApi.fileUrl(surface.mask_path), width, height)
      .then((grid) => { if (!cancelled) setAlpha(grid); })
      .catch(() => { if (!cancelled) setAlpha(null); });
    return () => { cancelled = true; };
  }, [analysis, surfaceKey, width, height]);

  return alpha;
}

function loadAlphaGrid(url, width, height) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      const data = ctx.getImageData(0, 0, width, height).data;
      const grid = new Uint8Array(width * height);
      for (let i = 0; i < grid.length; i++) grid[i] = data[i * 4 + 3];
      resolve(grid);
    };
    img.onerror = reject;
    img.src = url;
  });
}
