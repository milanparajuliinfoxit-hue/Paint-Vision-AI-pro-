import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ai } from '../../../shared/lib/api';

const TERMINAL_STAGES = new Set(['idle', 'ready', 'failed']);

// Polls the autonomous pipeline's derived status (understanding -> schemes ->
// ready|failed, see backend aiPipeline.service.js) every 2s while a stage is
// actually in flight; stops polling once terminal. Whenever the stage
// changes, invalidates the analysis/recommendations queries so the AI
// Understand / AI Schemes tabs pick up the new data without a manual refetch
// (this is the one place that translates "pipeline progressed" into "the
// rest of the UI should re-read the database").
export function useAiPipelineStatus(assetId) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['ai-pipeline-status', assetId],
    queryFn: () => ai.getStatus(assetId),
    enabled: !!assetId,
    refetchInterval: (q) => (TERMINAL_STAGES.has(q.state.data?.stage) ? false : 2000),
  });

  const stage = query.data?.stage;
  useEffect(() => {
    if (!assetId || !stage) return;
    queryClient.invalidateQueries({ queryKey: ['ai-analysis', assetId] });
    queryClient.invalidateQueries({ queryKey: ['ai-recommendations', assetId] });
  }, [assetId, stage, queryClient]);

  return query;
}

// Starts the pipeline for a given asset (idempotent server-side unless
// force). Not bound to one assetId up front — the upload handler calls this
// with whichever asset it just created, and a failed-state "Try again"
// button calls it with {force: true} for the currently active asset.
export function useStartAiPipeline() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ assetId, force } = {}) => ai.process(assetId, { force }),
    onSuccess: (status, { assetId }) => {
      queryClient.setQueryData(['ai-pipeline-status', assetId], status);
    },
  });
}
