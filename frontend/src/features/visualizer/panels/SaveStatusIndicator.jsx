import { useEffect, useState } from 'react';
import { useIsMutating, useIsFetching, useMutationState } from '@tanstack/react-query';

// Never a blocking save action (requirements doc, Section 7) — just a quiet
// status readout, wrapped in an ARIA live region so save/export completion
// is announced without a sighted user needing to watch the corner of the
// screen (Section 12). Presented as a pill with a status dot so the workspace
// header reads like a native app toolbar.
export default function SaveStatusIndicator() {
  const isMutating = useIsMutating();
  const isFetching = useIsFetching();
  const mutationStates = useMutationState({ select: (m) => m.state.status });
  const hasError = mutationStates.some((s) => s === 'error');

  const [label, setLabel] = useState('Saved');

  useEffect(() => {
    // Nothing retries a failed mutation here, so don't claim it does — the
    // error toast names the operation; this pill just keeps the failure
    // visible in the header until a later save succeeds.
    if (hasError) setLabel('Some changes did not save');
    else if (isMutating || isFetching) setLabel('Saving…');
    else setLabel('Saved');
  }, [isMutating, isFetching, hasError]);

  const dotColor =
    label === 'Saved' ? 'bg-[var(--success)]' : label.startsWith('Some changes') ? 'bg-[var(--danger)]' : 'bg-[var(--warning)]';
  const textColor =
    label === 'Saved' ? 'text-[var(--success)]' : label.startsWith('Some changes') ? 'text-[var(--danger)]' : 'text-[var(--graphite)]';

  return (
    <div
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--paper)] px-2.5 py-1 text-xs font-medium"
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColor} ${label === 'Saving…' ? 'animate-pulse' : ''}`} />
      <span className={textColor}>{label}</span>
    </div>
  );
}
