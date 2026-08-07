import { RotateCcw } from 'lucide-react';
import { useAiPipelineStatus, useStartAiPipeline } from '../hooks/useAiPipeline';
import { Button } from '../../../shared/ui/button';

const STAGE_COPY = {
  understanding: 'Understanding your house…',
  schemes: 'Preparing color combinations…',
};

// Autonomous-pipeline progress, in product language only — no provider
// names, job ids, or confidence scores (those stay in the AI Understand /
// AI Schemes tabs' diagnostics, per the "no raw backend states in the
// primary UX" rule). Renders nothing once the pipeline is idle (nothing
// uploaded yet) or ready (the side panel itself is the "done" signal).
export default function AiPipelineStatusBar({ assetId }) {
  const { data: status } = useAiPipelineStatus(assetId);
  const retry = useStartAiPipeline();

  if (!status || status.stage === 'idle' || status.stage === 'ready') return null;

  if (status.stage === 'failed') {
    const label = status.failedAt === 'understanding'
      ? "We couldn't finish understanding this photo."
      : 'We understood the photo, but couldn’t prepare color schemes.';
    return (
      <div className="flex items-center gap-3 border-b border-[var(--danger)]/20 bg-[var(--danger)]/10 px-4 py-2 text-xs font-medium text-[var(--graphite-dark)]">
        <span className="flex-1">{label}</span>
        <Button size="sm" variant="ghost" disabled={retry.isPending} onClick={() => retry.mutate({ assetId, force: true })}>
          <RotateCcw size={13} className="mr-1" /> Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 border-b border-[var(--line)] bg-[var(--paper-raised)] px-4 py-2 text-xs font-medium text-[var(--graphite)]">
      <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-[var(--signal)] border-t-transparent" />
      {STAGE_COPY[status.stage] || 'Preparing your visualization…'}
    </div>
  );
}
