import { RotateCcw } from 'lucide-react';
import { useAiPipelineStatus, useStartAiPipeline } from '../hooks/useAiPipeline';
import { Button } from '../../../shared/ui/button';

const STAGE_COPY = {
  understanding: 'Understanding your house…',
  schemes: 'Preparing color combinations…',
};

// Compact top-bar indicator for the two "running" stages — nothing while
// idle/ready (the workspace itself is the "done" signal), no failure UI
// (that's the banner below, which needs room for an explanation + retry).
export function AiPipelineStatusChip({ assetId }) {
  const { data: status } = useAiPipelineStatus(assetId);
  const copy = status && STAGE_COPY[status.stage];
  if (!copy) return null;

  return (
    <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--graphite)]">
      <span className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-2 border-[var(--signal)] border-t-transparent" />
      {copy}
    </div>
  );
}

// Failure banner only — the running-state indicator lives inline in the top
// bar (VisualizerWorkspace's header, next to SaveStatusIndicator) since it's
// small enough to fit there per the brief's top-bar layout. A failure needs
// more room (explanation + retry action), so it gets the full-width strip.
export default function AiPipelineStatusBar({ assetId }) {
  const { data: status } = useAiPipelineStatus(assetId);
  const retry = useStartAiPipeline();

  if (!status || status.stage !== 'failed') return null;

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
