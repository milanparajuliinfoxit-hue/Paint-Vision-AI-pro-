import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { assets } from '../../../shared/lib/api';

export function useAssetsList(projectId) {
  return useQuery({
    queryKey: ['assets', projectId],
    queryFn: () => assets.list(projectId),
    enabled: !!projectId,
  });
}

export function useUploadAsset(projectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file) => assets.upload(projectId, file),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['assets', projectId] }),
  });
}

export function useCleanAsset(projectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ assetId, maskBlob }) => assets.clean(assetId, maskBlob),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['assets', projectId] }),
  });
}

export function useRenameAsset(projectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ assetId, label }) => assets.rename(assetId, label),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['assets', projectId] }),
  });
}

export function useDeleteAsset(projectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (assetId) => assets.remove(assetId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['assets', projectId] }),
  });
}

export function useDuplicateAsset(projectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (assetId) => assets.duplicate(assetId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['assets', projectId] }),
  });
}
