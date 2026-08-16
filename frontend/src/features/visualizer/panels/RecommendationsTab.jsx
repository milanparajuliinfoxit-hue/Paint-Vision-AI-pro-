import { useEffect, useMemo, useState } from 'react';
import { Wand2, BookmarkPlus, Check, Sparkles } from 'lucide-react';
import { useAssetAnalysis } from '../hooks/useAiAnalysis';
import { useGenerateRecommendations, useRecommendations } from '../hooks/useRecommendations';
import { useApplySurface } from '../hooks/useApplySurface';
import { useSaveConcept } from '../hooks/useConcepts';
import { useAiMeta } from '../hooks/useAiAnalysis';
import { useGenerateVisualization, useVisualizationStatus, useVisualizationsList } from '../hooks/useVisualization';
import { renderSchemePreview, downscaleImageData, canvasToThumbnailBlob } from '../lib/renderSchemePreview';
import { MAX_PREVIEW_DIM, buildPreviewCacheKey, createBoundedCache } from '../lib/schemePreviewCore';
import { useToast } from '../../../shared/ui/toast';
import { Button } from '../../../shared/ui/button';
import { assets as assetsApi } from '../../../shared/lib/api';

const ROLE_LABELS = {
  'primary-wall': 'Primary wall',
  'accent-wall': 'Accent wall',
  roof: 'Roof',
  trim: 'Trim',
  gutter: 'Gutter',
  doors: 'Doors',
};

// Cached rendered previews, keyed by asset:scheme:analysis:size so reopening
// the tab (or switching assets) never re-runs the paint pass for a preview it
// already rendered. Bounded — see schemePreviewCore.createBoundedCache.
const PREVIEW_CACHE = createBoundedCache({ maxEntries: 64 });

// Error-isolation marker: a scheme whose preview failed shows a placeholder
// instead of taking down the whole panel.
const FAILED_PREVIEW = { failed: true };

// Catalog-only paint schemes. Every scheme maps each detected surface to a
// paint that exists in the catalog (resolved to a full paint object
// server-side) — the AI never invents a color. Applying a scheme creates one
// real layer per paintable surface through the standard layers API.
//
// Each scheme card shows a RENDERED preview — the same applyPaintColor pass
// the layer nodes use, composed over the base image — but ONLY at preview
// resolution (max 256px) and ONLY one scheme at a time, so opening this panel
// is cheap and never allocates workspace-sized buffers (the P0 crash fix).
// "Save as concept" persists the rendered thumbnail + surfaceClass->paintId
// map so the look can be re-applied as editable layers later.
export default function RecommendationsTab({ projectId, assetId, width, height, baseImageData }) {
  const showToast = useToast();
  const { data: aiMeta } = useAiMeta();
  const recommendationEnabled = aiMeta?.ai?.recommendation?.enabled;

  const { data: analysis } = useAssetAnalysis(assetId);
  const { data: schemes = [] } = useRecommendations(assetId);
  const generate = useGenerateRecommendations(assetId);
  const { applyScheme } = useApplySurface(projectId, assetId, { width, height });
  const saveConcept = useSaveConcept(projectId);

  // Gemini photorealistic preview — separate from the deterministic LAB
  // preview above. NOT the same thing: the composite preview is instant and
  // always available; the Gemini preview is an optional, billed, async call
  // the dealer opts into per scheme (Section 22 — separate concerns:
  // house understanding / color scheme / image generation).
  const visualizationEnabled = aiMeta?.ai?.visualization?.enabled;
  const visualizationProvider = aiMeta?.ai?.visualization?.provider;
  const { data: visualizations = [] } = useVisualizationsList(assetId);
  const generateViz = useGenerateVisualization(assetId);
  const [pendingVizIds, setPendingVizIds] = useState({});

  // Most recent visualization per scheme (list is newest-first already).
  const vizByScheme = useMemo(() => {
    const map = new Map();
    for (const v of visualizations) {
      if (v.scheme_id != null && !map.has(v.scheme_id)) map.set(v.scheme_id, v);
    }
    return map;
  }, [visualizations]);

  // class_key -> detected surface, so applying a scheme never references a
  // surface the analysis didn't actually find.
  const surfacesByClass = useMemo(() => {
    const map = new Map();
    for (const s of analysis?.surfaces || []) map.set(s.class_key, s);
    return map;
  }, [analysis]);

  // Identity of the analysis that produced the current surfaces — part of the
  // preview cache key, so a re-analysis invalidates old previews automatically.
  const analysisId = analysis?.job?.id ?? analysis?.surfaces?.[0]?.analysis_id ?? null;

  const analyzed = analysis?.analyzed;

  // Preview URLs/canvases keyed by scheme id. Previews are generated once,
  // cached, and stored as stable data URLs — React render only reads the URL
  // and never calls canvas.toDataURL.
  const [previews, setPreviews] = useState({});
  const [savedNames, setSavedNames] = useState({});

  useEffect(() => {
    if (!analyzed || !baseImageData || !width || !height) {
      setPreviews({});
      return undefined;
    }

    const controller = new AbortController();
    let cancelled = false;

    // Seed this mount from the preview cache; only schemes not already
    // rendered for this (asset, analysis, size) get queued for generation.
    const seed = {};
    const toRender = [];
    for (const scheme of schemes) {
      const key = buildPreviewCacheKey({ assetId, schemeId: scheme.id, analysisId, size: MAX_PREVIEW_DIM });
      const cached = PREVIEW_CACHE.get(key);
      if (cached) {
        seed[scheme.id] = cached;
      } else {
        toRender.push({ scheme, key });
      }
    }
    setPreviews(seed);

    (async () => {
      if (toRender.length === 0) return;

      // Base image downscaled once per run — every applyPaintColor pass below
      // operates on this bounded image, never on the 1600×1200 workspace.
      const previewBase = await downscaleImageData(baseImageData, width, height, MAX_PREVIEW_DIM);

      // Strictly sequential generation (concurrency 1). The old
      // Promise.all(schemes.map(...)) fired N×M full-resolution LAB passes at
      // once; this streams one bounded scheme at a time.
      for (const { scheme, key } of toRender) {
        if (cancelled || controller.signal.aborted) break;
        try {
          const canvas = await renderSchemePreview({
            baseImageData: previewBase.imageData,
            scheme,
            surfacesByClass,
            width: previewBase.width,
            height: previewBase.height,
            signal: controller.signal,
          });
          if (cancelled || controller.signal.aborted || !canvas) break;
          const entry = { url: canvas.toDataURL('image/png'), canvas };
          PREVIEW_CACHE.set(key, entry);
          setPreviews((prev) => ({ ...prev, [scheme.id]: entry }));
        } catch (err) {
          if (cancelled || err?.name === 'AbortError') break;
          // Error isolation: one failed preview becomes a placeholder, never
          // a crashed panel.
          setPreviews((prev) => ({ ...prev, [scheme.id]: FAILED_PREVIEW }));
        }
      }
    })().catch(() => {});

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [analyzed, baseImageData, width, height, schemes, surfacesByClass, assetId, analysisId]);

  async function runGenerate() {
    try {
      const res = await generate.mutateAsync();
      showToast(`${res?.meta?.count || schemes.length} schemes generated from catalog paints.`);
    } catch (err) {
      showToast(err.message || 'Recommendation generation failed.', { variant: 'danger' });
    }
  }

  async function apply(scheme) {
    try {
      const layer = await applyScheme(scheme, surfacesByClass);
      showToast(layer ? `Applied "${scheme.name}" — paint the layers from the catalog.` : 'Nothing to apply — no paintable surfaces detected.');
    } catch (err) {
      // applyScheme creates one layer per surface with sequential requests —
      // a failure partway through leaves whichever surfaces already
      // succeeded as real layers. That's safe to resolve (not corrupted
      // state) because every apply is idempotent server-side (upsert on
      // ai_analysis_id + ai_surface_key, see useApplySurface.js) — clicking
      // Apply again re-applies the whole scheme and only touches the
      // surfaces that didn't finish, without duplicating the ones that did.
      showToast(`${err.message || 'Could not finish applying the scheme.'} Some colors may already be applied — click Apply again to finish the rest.`, { variant: 'danger' });
    }
  }

  // Kicks off (or, if an identical plan was already generated, reuses) a
  // Gemini recolor of the real photo — every color comes from the scheme's
  // own catalog paint ids, never freehand text (governing brief Section 7).
  //
  // Gemini-first migration: surfaceKey is the surface's semantic `role`
  // (primary-wall/accent-wall/trim/roof/gutter/doors), not its detected
  // `surfaceClass` (front-wall, window-frame-2, ...) — visualization.service.js
  // now validates against the fixed architecturalCategories vocabulary
  // (which deliberately reuses these same role names), not detected_surfaces,
  // so a raw class_key would be rejected as an unknown category.
  async function generateVisualization(scheme) {
    const surfaceColorPlan = (scheme.surfaces || [])
      .filter((s) => s.paintId && s.role && surfacesByClass.get(s.surfaceClass)?.paintable !== false)
      .map((s) => ({ surfaceKey: s.role, paintId: s.paintId }));
    if (surfaceColorPlan.length === 0) {
      showToast('No paintable surfaces with catalog colors to visualize.', { variant: 'danger' });
      return;
    }
    try {
      const viz = await generateViz.mutateAsync({ surfaceColorPlan, schemeId: scheme.id });
      setPendingVizIds((prev) => ({ ...prev, [scheme.id]: viz.id }));
    } catch (err) {
      showToast(err.message || 'Could not start the photorealistic preview.', { variant: 'danger' });
    }
  }

  // Persists the rendered look: the preview canvas downscaled to a thumbnail
  // plus surfaceClass -> paintId, so it re-applies as real layers later.
  async function saveAsConcept(scheme) {
    const preview = previews[scheme.id];
    if (!preview || preview.failed) {
      showToast('Preview is still rendering or unavailable — try again in a moment.', { variant: 'danger' });
      return;
    }
    try {
      const layerColorMap = {};
      for (const s of scheme.surfaces || []) {
        if (s.paintId) layerColorMap[s.surfaceClass] = s.paintId;
      }
      const thumbnailBlob = await canvasToThumbnailBlob(preview.canvas);
      await saveConcept.mutateAsync({ name: scheme.name, layerColorMap, thumbnailBlob });
      setSavedNames((prev) => ({ ...prev, [scheme.id]: true }));
      showToast(`Saved "${scheme.name}" as a concept.`);
    } catch (err) {
      showToast(err.message || 'Could not save concept.', { variant: 'danger' });
    }
  }

  return (
    <div className="p-3 flex flex-col gap-3">
      {!analyzed && (
        <p className="text-xs text-[var(--graphite)] leading-snug">
          Run AI analysis first (Understand tab) — recommendations need to know which surfaces to paint.
        </p>
      )}

      {recommendationEnabled === false && (
        <p className="text-xs text-[var(--warning)] leading-snug">
          AI recommendations are disabled on this deployment (AI_RECOMMENDATION_ENABLED=false).
        </p>
      )}

      {analyzed && (
        <Button onClick={runGenerate} disabled={generate.isPending || recommendationEnabled === false}>
          {generate.isPending ? 'Generating schemes…' : `Generate ${aiMeta?.ai?.recommendation?.count || 6} schemes`}
        </Button>
      )}

      {analyzed && schemes.length === 0 && !generate.isPending && (
        <p className="text-xs text-[var(--graphite)] leading-snug">
          No schemes yet. Generate a batch to see 5–10 complete color plans, each with a primary wall,
          accents, trim, roof and gutter mapped to real catalog paints.
        </p>
      )}

      <div className="flex flex-col gap-2.5">
        {schemes.map((scheme) => (
          <div key={scheme.id} className="rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--paper)] p-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-xs font-semibold text-[var(--ink)]">{scheme.name}</div>
                {scheme.tagline && <div className="mt-0.5 text-[11px] leading-snug text-[var(--graphite)]">{scheme.tagline}</div>}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button size="sm" variant="secondary" onClick={() => apply(scheme)}>Apply</Button>
                <Button size="sm" variant="ghost" onClick={() => saveAsConcept(scheme)} disabled={saveConcept.isPending || !previews[scheme.id]?.canvas}>
                  {savedNames[scheme.id] ? <Check size={14} /> : <BookmarkPlus size={14} />}
                </Button>
              </div>
            </div>

            <div className="mt-2 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--paper-raised)] overflow-hidden">
              {previews[scheme.id]?.url ? (
                <img
                  src={previews[scheme.id].url}
                  alt={`${scheme.name} preview`}
                  className="w-full h-28 object-cover"
                />
              ) : previews[scheme.id]?.failed ? (
                <div className="h-28 flex items-center justify-center text-[11px] text-[var(--danger)]">
                  Preview unavailable
                </div>
              ) : (
                <div className="h-28 flex items-center justify-center text-[11px] text-[var(--graphite)]">
                  Rendering preview…
                </div>
              )}
            </div>

            <div className="mt-2 flex items-center gap-1">
              {(scheme.surfaces || []).map((s, i) => (
                <span
                  key={i}
                  title={`${ROLE_LABELS[s.role] || s.role}: ${s.paint?.color_name || s.paintId || 'unset'}`}
                  className="h-7 flex-1 rounded-[var(--radius-sm)] border border-white/40"
                  style={{ background: s.paint?.hex_value || 'transparent' }}
                />
              ))}
            </div>

            <ul className="mt-2 flex flex-col gap-1">
              {(scheme.surfaces || []).map((s, i) => (
                <li key={i} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-[var(--graphite)]">{ROLE_LABELS[s.role] || s.role}</span>
                  <span className="truncate font-medium text-[var(--ink)]">{s.paint?.color_name || '—'}</span>
                </li>
              ))}
            </ul>

            <p className="mt-2 flex items-center gap-1 text-[10px] text-[var(--graphite)]">
              <Wand2 size={11} />
              Catalog-only — every color is a real product in the paint catalog.
            </p>

            {visualizationEnabled && visualizationProvider && (
              <div className="mt-2 border-t border-[var(--line)] pt-2">
                <SchemeVisualization
                  assetId={assetId}
                  visualizationId={pendingVizIds[scheme.id] || vizByScheme.get(scheme.id)?.id}
                  onGenerate={() => generateVisualization(scheme)}
                  generating={generateViz.isPending}
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// One scheme's Gemini photorealistic preview. A separate component (not
// inlined in the .map() above) because it needs its own poll hook instance
// per scheme — useVisualizationStatus is disabled (no polling) until a
// visualizationId exists, so schemes with no generation started yet cost
// nothing.
function SchemeVisualization({ assetId, visualizationId, onGenerate, generating }) {
  const { data: visualization } = useVisualizationStatus(assetId, visualizationId);
  const status = visualization?.status;

  if (!visualizationId) {
    return (
      <Button size="sm" variant="ghost" onClick={onGenerate} disabled={generating} className="w-full justify-center">
        <Sparkles size={13} className="mr-1" />
        {generating ? 'Starting…' : 'Generate photorealistic preview'}
      </Button>
    );
  }

  if (status === 'pending' || !status) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-[var(--graphite)]">
        <Sparkles size={13} className="animate-pulse" />
        Generating photorealistic preview… this can take up to a minute.
      </div>
    );
  }

  if (status === 'failed') {
    const reason = visualization?.validationJson?.failureReason;
    return (
      <div className="flex flex-col gap-1">
        <p className="text-[11px] text-[var(--danger)]">
          Photorealistic preview failed{reason ? `: ${reason}` : '.'}
        </p>
        <Button size="sm" variant="ghost" onClick={onGenerate} className="w-full justify-center">
          Try again
        </Button>
      </div>
    );
  }

  // status === 'ready'
  return (
    <div className="flex flex-col gap-1.5">
      <img
        src={assetsApi.fileUrl(visualization.result_path)}
        alt="Gemini photorealistic preview"
        className="w-full rounded-[var(--radius-sm)] border border-[var(--line)] object-cover"
      />
      <p className="flex items-center gap-1 text-[10px] text-[var(--graphite)]">
        <Sparkles size={11} />
        AI-generated photorealistic preview — use "Apply" above for the editable, re-colorable version.
      </p>
    </div>
  );
}
