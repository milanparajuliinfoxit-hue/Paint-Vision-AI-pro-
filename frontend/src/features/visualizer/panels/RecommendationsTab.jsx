import { useEffect, useMemo, useRef, useState } from 'react';
import { Wand2, BookmarkPlus, Check } from 'lucide-react';
import { useAssetAnalysis } from '../hooks/useAiAnalysis';
import { useGenerateRecommendations, useRecommendations } from '../hooks/useRecommendations';
import { useApplySurface } from '../hooks/useApplySurface';
import { useSaveConcept } from '../hooks/useConcepts';
import { useAiMeta } from '../hooks/useAiAnalysis';
import { renderSchemePreview, canvasToThumbnailBlob } from '../lib/renderSchemePreview';
import { useToast } from '../../../shared/ui/toast';
import { Button } from '../../../shared/ui/button';

const ROLE_LABELS = {
  'primary-wall': 'Primary wall',
  'accent-wall': 'Accent wall',
  roof: 'Roof',
  trim: 'Trim',
  gutter: 'Gutter',
  doors: 'Doors',
};

// Catalog-only paint schemes. Every scheme maps each detected surface to a
// paint that exists in the catalog (resolved to a full paint object
// server-side) — the AI never invents a color. Applying a scheme creates one
// real layer per paintable surface through the standard layers API.
//
// Each scheme card shows a RENDERED preview — the same applyPaintColor pass
// the layer nodes use, composed over the full-size base image — so a dealer
// sees the finished look before committing. "Save as concept" persists the
// rendered thumbnail + surfaceClass->paintId map so the look can be re-applied
// as editable layers later.
export default function RecommendationsTab({ projectId, assetId, width, height, baseImageData }) {
  const showToast = useToast();
  const { data: aiMeta } = useAiMeta();
  const recommendationEnabled = aiMeta?.ai?.recommendation?.enabled;

  const { data: analysis } = useAssetAnalysis(assetId);
  const { data: schemes = [] } = useRecommendations(assetId);
  const generate = useGenerateRecommendations(assetId);
  const { applyScheme } = useApplySurface(projectId, assetId, { width, height });
  const saveConcept = useSaveConcept(projectId);

  // class_key -> detected surface, so applying a scheme never references a
  // surface the analysis didn't actually find.
  const surfacesByClass = useMemo(() => {
    const map = new Map();
    for (const s of analysis?.surfaces || []) map.set(s.class_key, s);
    return map;
  }, [analysis]);

  const analyzed = analysis?.analyzed;

  // Preview canvases, keyed by scheme id so a re-render reuses the last
  // computed thumbnail instead of re-running the LAB pass.
  const [previews, setPreviews] = useState({});
  const [savedNames, setSavedNames] = useState({});
  const previewGenRef = useRef(0);

  useEffect(() => {
    if (!analyzed || !baseImageData || !width || !height) {
      setPreviews({});
      return undefined;
    }
    const gen = ++previewGenRef.current;
    let cancelled = false;

    Promise.all(
      schemes.map(async (scheme) => {
        const canvas = await renderSchemePreview({ baseImageData, scheme, surfacesByClass, width, height });
        return { id: scheme.id, canvas };
      })
    ).then((results) => {
      if (cancelled) return;
      const next = {};
      for (const { id, canvas } of results) next[id] = canvas;
      setPreviews(next);
    }).catch(() => { if (!cancelled) setPreviews({}); });

    return () => { cancelled = true; };
  }, [analyzed, baseImageData, width, height, schemes, surfacesByClass]);

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
      showToast(err.message || 'Could not apply scheme.', { variant: 'danger' });
    }
  }

  // Persists the rendered look: the preview canvas downscaled to a thumbnail
  // plus surfaceClass -> paintId, so it re-applies as real layers later.
  async function saveAsConcept(scheme) {
    const preview = previews[scheme.id];
    if (!preview) {
      showToast('Preview is still rendering — try again in a moment.', { variant: 'danger' });
      return;
    }
    try {
      const layerColorMap = {};
      for (const s of scheme.surfaces || []) {
        if (s.paintId) layerColorMap[s.surfaceClass] = s.paintId;
      }
      const thumbnailBlob = await canvasToThumbnailBlob(preview);
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
                <Button size="sm" variant="ghost" onClick={() => saveAsConcept(scheme)} disabled={saveConcept.isPending || !previews[scheme.id]}>
                  {savedNames[scheme.id] ? <Check size={14} /> : <BookmarkPlus size={14} />}
                </Button>
              </div>
            </div>

            <div className="mt-2 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--paper-raised)] overflow-hidden">
              {previews[scheme.id] ? (
                <img
                  src={previews[scheme.id].toDataURL('image/png')}
                  alt={`${scheme.name} preview`}
                  className="w-full h-28 object-cover"
                />
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
          </div>
        ))}
      </div>
    </div>
  );
}
