import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ai } from '../../../shared/lib/api';

const TERMINAL_STATUSES = new Set(['ready', 'failed']);

// Every Gemini image operation (prepare_house, remove_objects,
// visualize_paint, change_color) creates one row in the same unified
// revision timeline (backend: ai_visualizations table, see its own header
// comment) and is polled the exact same way — this is what lets the
// frontend treat "prepare the house" and "paint the walls" as the same
// kind of operation instead of bespoke per-feature plumbing.

// Starts (or reuses an existing identical) Gemini paint recolor.
// taskType defaults to 'visualize_paint' server-side; pass 'change_color'
// + parentRevisionId to regenerate a specific existing result with an
// updated color plan instead of chaining from the asset's latest revision.
export function useGenerateVisualization(assetId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ surfaceColorPlan, schemeId, userIntent, taskType, parentRevisionId }) =>
      ai.requestVisualization(assetId, { surfaceColorPlan, schemeId, userIntent, taskType, parentRevisionId }),
    onSuccess: (revision) => {
      queryClient.setQueryData(['ai-visualization', assetId, revision.id], revision);
      queryClient.invalidateQueries({ queryKey: ['ai-visualizations', assetId] });
    },
  });
}

// House preparation (task_type 'prepare_house') — the fixed, comprehensive
// "isolate the house from its surroundings" edit.
export function useRequestIsolation(assetId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => ai.requestIsolation(assetId),
    onSuccess: (revision) => {
      queryClient.setQueryData(['ai-visualization', assetId, revision.id], revision);
      queryClient.invalidateQueries({ queryKey: ['ai-visualizations', assetId] });
    },
  });
}

// Targeted object removal (task_type 'remove_objects') — dealer specifies
// exactly what to remove in their own words.
export function useRequestObjectRemoval(assetId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userIntent) => ai.requestObjectRemoval(assetId, { userIntent }),
    onSuccess: (revision) => {
      queryClient.setQueryData(['ai-visualization', assetId, revision.id], revision);
      queryClient.invalidateQueries({ queryKey: ['ai-visualizations', assetId] });
    },
  });
}

// Polls a single revision (any task type) until it reaches a terminal
// state (ready or failed). `revisionId` is null until a generation has
// been started, in which case the query stays disabled.
export function useVisualizationStatus(assetId, revisionId) {
  return useQuery({
    queryKey: ['ai-visualization', assetId, revisionId],
    queryFn: () => ai.getVisualization(assetId, revisionId),
    enabled: !!assetId && !!revisionId,
    refetchInterval: (q) => (TERMINAL_STATUSES.has(q.state.data?.status) ? false : 2000),
  });
}

// The full revision history for this asset (most recent first) — the
// "Original -> Prepared -> Painted -> re-colored" lineage the workspace
// renders, spanning all four task types in one list.
export function useVisualizationsList(assetId) {
  return useQuery({
    queryKey: ['ai-visualizations', assetId],
    queryFn: () => ai.listVisualizations(assetId),
    enabled: !!assetId,
  });
}
