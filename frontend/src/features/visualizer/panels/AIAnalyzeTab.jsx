import { useEffect, useMemo, useState } from 'react';
import { BrainCircuit, ScanSearch, Layers as LayersIcon } from 'lucide-react';
import { useAiMeta, useAnalyzeAsset, useAssetAnalysis } from '../hooks/useAiAnalysis';
import { useApplySurface } from '../hooks/useApplySurface';
import { useToast } from '../../../shared/ui/toast';
import { Button } from '../../../shared/ui/button';
import InlineColorPicker from '../components/InlineColorPicker';

const ROLE_LABELS = {
  'primary-wall': 'Primary wall',
  'accent-wall': 'Accent wall',
  roof: 'Roof',
  trim: 'Trim',
  gutter: 'Gutter',
  doors: 'Doors',
};

// A detected class_key like "windows-3" or "front-wall-2" is one instance;
// dedupeKey in the backend's gemini-vision provider only ever appends a
// numeric "-N" suffix to a repeated instance of the SAME class (see
// geminiVisionProvider.js), never to two genuinely different classes
// (front-wall/left-wall/right-wall are distinct keys already, not
// suffix-derived) — so stripping a trailing "-<number>" is always safe and
// groups only true repeats of one surface type together.
function groupKeyOf(classKey) {
  return classKey.replace(/-\d+$/, '');
}

function groupSurfaces(surfaces) {
  const groups = new Map();
  for (const s of surfaces || []) {
    const key = groupKeyOf(s.class_key);
    if (!groups.has(key)) {
      groups.set(key, {
        groupKey: key,
        displayName: (s.display_name || s.class_key).replace(/\s*\d+$/, ''),
        paintable: s.paintable,
        role: s.properties?.role || null,
        members: [],
      });
    }
    groups.get(key).members.push(s);
  }
  return [...groups.values()];
}

/**
 * "AI Details" — the pixel-segmentation diagnostic view (Gemini-first
 * migration, governing brief Section 16/17): raw detected surfaces/objects,
 * confidence, model version. This used to be the *only* way into AI
 * painting; it no longer gates anything (AIWorkspaceTab is the primary
 * workflow and needs zero segmentation to run). What's left here is
 * genuinely useful on its own merits, not a demoted duplicate: precise
 * per-instance masks for manual layer refinement ("this one balcony
 * railing's mask is more accurate than a hand-drawn lasso would be") and
 * visibility into what the AI actually detected, for dealers/support who
 * want to see the diagnostics.
 */
export default function AIAnalyzeTab({ projectId, assetId, width, height }) {
  const showToast = useToast();
  const { data: aiMeta } = useAiMeta();
  const analysisEnabled = aiMeta?.ai?.analysis?.enabled;
  const provider = aiMeta?.ai?.analysis?.provider || 'mock';

  const { data: analysis, isFetching: analysisRefetching } = useAssetAnalysis(assetId);
  const analyze = useAnalyzeAsset(assetId);
  const { applySurface } = useApplySurface(projectId, assetId, { width, height });

  const analyzed = analysis?.analyzed;
  const running = analyze.isPending || analysisRefetching;
  const activeProvider = analysis?.job?.provider || provider;
  const isMockProvider = activeProvider === 'mock';
  const analysisId = analysis?.job?.id ?? null;

  const groups = useMemo(() => groupSurfaces(analysis?.surfaces), [analysis]);

  // groupKey -> selected catalog paint. Reset whenever a fresh analysis
  // lands (a re-analyze can change surfaces entirely, so a stale selection
  // referencing a surface that no longer exists must not linger).
  const [groupColors, setGroupColors] = useState({});
  useEffect(() => { setGroupColors({}); }, [analysisId]);

  async function runAnalysis() {
    try {
      await analyze.mutateAsync();
      showToast('AI analysis complete — surfaces detected.');
    } catch (err) {
      showToast(err.message || 'Analysis failed.', { variant: 'danger' });
    }
  }

  function setGroupColor(groupKey, paint) {
    setGroupColors((prev) => ({ ...prev, [groupKey]: paint }));
  }

  async function addGroupAsLayers(group) {
    const paint = groupColors[group.groupKey];
    if (!paint) {
      showToast('Choose a color first.', { variant: 'danger' });
      return;
    }
    try {
      for (const member of group.members) await applySurface(member, paint);
      showToast(`Added ${group.members.length} layer${group.members.length > 1 ? 's' : ''} for "${group.displayName}".`);
    } catch (err) {
      showToast(err.message || 'Could not add layers.', { variant: 'danger' });
    }
  }

  return (
    <div className="p-3 flex flex-col gap-3">
      <p className="text-[11px] leading-snug text-[var(--graphite)]">
        Diagnostic view — shows exactly what the AI detected in this photo. Not required for AI
        Visualization (see the AI Workspace tab), useful for precise manual layer placement.
      </p>

      {analysisEnabled === false && (
        <p className="text-xs text-[var(--warning)] leading-snug">
          AI analysis is disabled on this deployment (AI_ANALYSIS_ENABLED=false).
        </p>
      )}

      <div className="flex items-center gap-2 text-xs text-[var(--graphite)]">
        <ScanSearch size={14} className="shrink-0" />
        <span>Provider: <span className="font-medium text-[var(--ink)]">{activeProvider}</span></span>
        {isMockProvider && (
          <span
            title="This deployment has no real vision model configured — surfaces are estimated with simple heuristics, not a trained model."
            className="rounded-full bg-[var(--warning)]/15 px-2 py-0.5 text-[10px] font-medium text-[var(--warning)]"
          >
            Rule-based preview
          </span>
        )}
      </div>

      <Button onClick={runAnalysis} disabled={!assetId || running || analysisEnabled === false}>
        {running ? (
          <span className="inline-flex items-center gap-2">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            Understanding photo…
          </span>
        ) : analyzed ? (
          'Re-analyze photo'
        ) : (
          'Understand this photo'
        )}
      </Button>

      {analyzed && analysis.job && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--graphite)] border-b border-[var(--line)] pb-2">
          <span>Model <span className="text-[var(--ink)]">{analysis.job.model_version}</span></span>
          <span>Confidence <span className="text-[var(--ink)]">{Math.round((analysis.job.confidence || 0) * 100)}%</span></span>
          {analysis.job.processing_time_ms != null && <span>{analysis.job.processing_time_ms} ms</span>}
        </div>
      )}

      {analyzed && analysis.house?.present === false && (
        <p className="text-xs text-[var(--warning)] leading-snug">
          No house detected in this photo. Try a clearer exterior shot.
        </p>
      )}

      {analyzed && groups.length > 0 && (
        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase text-[var(--graphite)]">
            <BrainCircuit size={13} /> Detected surfaces
          </h3>
          <ul className="flex flex-col gap-1.5">
            {groups.map((group) => {
              const role = group.role ? ROLE_LABELS[group.role] || group.role : null;
              return (
                <li key={group.groupKey} className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--paper)] px-2 py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-[var(--ink)]">
                      {group.displayName}
                      {group.members.length > 1 && <span className="ml-1 text-[10px] text-[var(--graphite)]">×{group.members.length}</span>}
                    </div>
                    {role && <div className="text-[11px] text-[var(--graphite)]">{role}</div>}
                  </div>
                  {group.paintable ? (
                    <>
                      <InlineColorPicker value={groupColors[group.groupKey]} onChange={(paint) => setGroupColor(group.groupKey, paint)} />
                      <Button size="sm" variant="ghost" onClick={() => addGroupAsLayers(group)} title="Add as editable layer(s) now">
                        <LayersIcon size={13} />
                      </Button>
                    </>
                  ) : (
                    <span className="rounded-[var(--radius-sm)] bg-[var(--danger)]/10 px-2 py-0.5 text-[10px] font-medium text-[var(--danger)]">
                      Not paintable
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {analyzed && (analysis.objects || []).length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase text-[var(--graphite)]">Protected objects</h3>
          <ul className="flex flex-wrap gap-1.5">
            {(analysis.objects || []).map((o) => (
              <li key={o.id} className="rounded-full border border-[var(--line)] bg-[var(--paper)] px-2.5 py-1 text-[11px] text-[var(--graphite)]">
                {o.display_name}
                <span className="ml-1 text-[10px] text-[var(--danger)]">
                  {o.category === 'unrelated-object' ? 'not part of the house · removable' : 'part of the house · never painted'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!analyzed && !running && (
        <p className="text-xs text-[var(--graphite)] leading-snug">
          The AI detects the house and its architectural surfaces (walls, trim, windows, doors,
          balconies, railings, compound walls…) — nothing is painted automatically.
        </p>
      )}
    </div>
  );
}
