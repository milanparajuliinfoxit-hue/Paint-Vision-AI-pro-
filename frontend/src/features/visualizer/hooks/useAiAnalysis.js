import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ai, assets as assetsApi, meta } from '../../../shared/lib/api';
import { loadAlphaGrid } from '../../../shared/lib/maskImage';
import { unionAlphaGrids } from '../tools/maskOps';

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
    loadAlphaGrid(assetsApi.fileUrl(surface.mask_path), width, height, analysis?.job?.id)
      .then((grid) => { if (!cancelled) setAlpha(grid); })
      .catch(() => { if (!cancelled) setAlpha(null); });
    return () => { cancelled = true; };
  }, [analysis, surfaceKey, width, height]);

  return alpha;
}

// Alpha grids for every paintable detected surface at canvas resolution, in
// paint-stacking order (later entries render on top). Used by the surface-pick
// tool to resolve a canvas click to the surface under the cursor. Returns an
// array of { surface, alpha, width, height }; empty while loading.
export function useSurfaceAlphaGrids({ analysis, width, height }) {
  const [surfaceMasks, setSurfaceMasks] = useState([]);

  useEffect(() => {
    setSurfaceMasks([]);
    if (!width || !height) return undefined;

    const surfaces = (analysis?.surfaces || []).filter((s) => s.paintable && s.mask_path);
    if (surfaces.length === 0) return undefined;

    let cancelled = false;
    Promise.all(
      surfaces.map(async (surface) => {
        const alpha = await loadAlphaGrid(assetsApi.fileUrl(surface.mask_path), width, height, analysis?.job?.id);
        return { surface, alpha, width, height };
      })
    ).then((entries) => { if (!cancelled) setSurfaceMasks(entries); })
      .catch(() => { if (!cancelled) setSurfaceMasks([]); });

    return () => { cancelled = true; };
  }, [analysis, width, height]);

  return surfaceMasks;
}

// Union of every detected surface's mask (paintable or not — a window/door
// is still part of the house) at canvas resolution: the deterministic
// "house region" the house-aware Magic Wand intersects its flood fill
// against, so a click on the house can never spread into sky, ground, or a
// neighboring structure. Returns null while loading or when no analysis has
// been run yet — callers fall back to the tool's own boundary-aware flood
// fill alone in that case, never to a fully unconstrained one.
export function useHouseProtectionAlpha({ analysis, width, height }) {
  const [houseAlpha, setHouseAlpha] = useState(null);

  useEffect(() => {
    setHouseAlpha(null);
    if (!width || !height) return undefined;
    const surfaces = (analysis?.surfaces || []).filter((s) => s.mask_path);
    if (surfaces.length === 0) return undefined;

    let cancelled = false;
    Promise.all(surfaces.map((s) => loadAlphaGrid(assetsApi.fileUrl(s.mask_path), width, height, analysis?.job?.id)))
      .then((grids) => { if (!cancelled) setHouseAlpha(unionAlphaGrids(grids)); })
      .catch(() => { if (!cancelled) setHouseAlpha(null); });
    return () => { cancelled = true; };
  }, [analysis, width, height]);

  return houseAlpha;
}

