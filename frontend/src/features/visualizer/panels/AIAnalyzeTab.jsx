import { BrainCircuit, ScanSearch } from 'lucide-react';
import { useAiMeta, useAnalyzeAsset, useAssetAnalysis } from '../hooks/useAiAnalysis';
import { useApplySurface } from '../hooks/useApplySurface';
import { useToast } from '../../../shared/ui/toast';
import { Button } from '../../../shared/ui/button';
import { cn } from '../../../shared/lib/cn';

const ROLE_LABELS = {
  'primary-wall': 'Primary wall',
  'accent-wall': 'Accent wall',
  roof: 'Roof',
  trim: 'Trim',
  gutter: 'Gutter',
  doors: 'Doors',
};

// AI house-understanding: analyze the photo, inspect every detected surface
// (paintable vs protected), and promote any surface to a real layer with one
// click. The AI only structures understanding — it never paints, and the
// renderer only ever sees regular layers from the layers API.
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

  async function runAnalysis() {
    try {
      await analyze.mutateAsync();
      showToast('AI analysis complete — surfaces detected.');
    } catch (err) {
      showToast(err.message || 'Analysis failed.', { variant: 'danger' });
    }
  }

  async function addSurface(surface) {
    try {
      const layer = await applySurface(surface, null);
      if (layer) showToast(`Added layer "${layer.name}" — pick a paint to color it.`);
    } catch (err) {
      showToast(err.message || 'Could not add surface.', { variant: 'danger' });
    }
  }

  return (
    <div className="p-3 flex flex-col gap-3">
      {analysisEnabled === false && (
        <p className="text-xs text-[var(--warning)] leading-snug">
          AI analysis is disabled on this deployment (AI_ANALYSIS_ENABLED=false).
        </p>
      )}

      <div className="flex items-center gap-2 text-xs text-[var(--graphite)]">
        <ScanSearch size={14} className="shrink-0" />
        <span>Provider: <span className="font-medium text-[var(--ink)]">{provider}</span></span>
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

      {!analyzed && !running && (
        <p className="text-xs text-[var(--graphite)] leading-snug">
          The AI detects the house, its paintable surfaces (walls, roof, trim, gutters…) and
          protected objects (windows, trees, cars) — nothing is painted automatically.
        </p>
      )}

      {running && !analyzed && <p className="text-xs text-[var(--graphite)]">This runs locally in the mock provider (no API key).</p>}

      {analyzed && analysis.job && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--graphite)] border-b border-[var(--line)] pb-2">
          <span>Model <span className="text-[var(--ink)]">{analysis.job.model_version}</span></span>
          <span>Confidence <span className="text-[var(--ink)]">{Math.round((analysis.job.confidence || 0) * 100)}%</span></span>
          {analysis.job.processing_time_ms != null && (
            <span>{analysis.job.processing_time_ms} ms</span>
          )}
        </div>
      )}

      {analyzed && analysis.house?.present === false && (
        <p className="text-xs text-[var(--warning)] leading-snug">
          No house detected in this photo. Try a clearer exterior shot.
        </p>
      )}

      {analyzed && (analysis.surfaces || []).length > 0 && (
        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase text-[var(--graphite)]">
            <BrainCircuit size={13} /> Detected surfaces
          </h3>
          <ul className="flex flex-col gap-1.5">
            {(analysis.surfaces || []).map((s) => {
              const role = s.properties?.role ? ROLE_LABELS[s.properties.role] || s.properties.role : null;
              const paintable = s.paintable;
              return (
                <li key={s.id} className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--paper)] px-2 py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-[var(--ink)]">{s.display_name}</div>
                    <div className="flex items-center gap-1.5 text-[11px] text-[var(--graphite)]">
                      {role && <span>{role}</span>}
                      {s.confidence != null && <span>· {Math.round(s.confidence * 100)}%</span>}
                    </div>
                  </div>
                  {paintable ? (
                    <Button size="sm" variant="secondary" onClick={() => addSurface(s)}>
                      Add layer
                    </Button>
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
                <span className="ml-1 text-[10px] text-[var(--danger)]">never painted</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!running && <p className={cn('text-[11px] text-[var(--graphite)] leading-snug', analyzed && 'mt-auto')}>
        Paint is never applied automatically — “Add layer” creates a real layer you can color from the catalog.
      </p>}
    </div>
  );
}
