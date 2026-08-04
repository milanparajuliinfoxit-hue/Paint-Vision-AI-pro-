import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ai } from '../../../shared/lib/api';

// Persisted catalog-only schemes for an asset (each surface maps to a real
// catalog paint resolved server-side).
export function useRecommendations(assetId) {
  return useQuery({
    queryKey: ['ai-recommendations', assetId],
    queryFn: () => ai.listRecommendations(assetId),
    enabled: !!assetId,
  });
}

// Generates a fresh batch (5-10 schemes, server clamps the count) — replaces
// the previous batch for the asset.
export function useGenerateRecommendations(assetId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (count) => ai.generateRecommendations(assetId, count),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ai-recommendations', assetId] }),
  });
}
