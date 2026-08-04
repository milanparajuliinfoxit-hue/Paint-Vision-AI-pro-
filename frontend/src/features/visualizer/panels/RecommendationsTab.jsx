import { useMemo } from 'react';
import { Wand2 } from 'lucide-react';
import { useAssetAnalysis } from '../hooks/useAiAnalysis';
import { useGenerateRecommendations, useRecommendations } from '../hooks/useRecommendations';
import { useApplySurface } from '../hooks/useApplySurface';
import { useAiMeta } from '../hooks/useAiAnalysis';
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
export default function RecommendationsTab({ projectId, assetId, width, height }) {
  const showToast = useToast();
  const { data: aiMeta } = useAiMeta();
  const recommendationEnabled = aiMeta?.ai?.recommendation?.enabled;

  const { data: analysis } = useAssetAnalysis(assetId);
  const { data: schemes = [] } = useRecommendations(assetId);
  const generate = useGenerateRecommendations(assetId);
  const { applyScheme } = useApplySurface(projectId, assetId, { width, height });

  // class_key -> detected surface, so applying a scheme never references a
  // surface the analysis didn't actually find.
  const surfacesByClass = useMemo(() => {
    const map = new Map();
    for (const s of analysis?.surfaces || []) map.set(s.class_key, s);
    return map;
  }, [analysis]);

  const analyzed = analysis?.analyzed;

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
              <Button size="sm" variant="secondary" onClick={() => apply(scheme)}>Apply</Button>
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
