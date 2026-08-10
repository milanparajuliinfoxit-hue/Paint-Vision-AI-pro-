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
    meta: { action: 'Uploading photo', handledLocally: true },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['assets', projectId] }),
  });
}

export function useCleanAsset(projectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ assetId, maskBlob }) => assets.clean(assetId, maskBlob),
    meta: { action: 'AI cleanup', handledLocally: true },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['assets', projectId] }),
  });
}

export function useRenameAsset(projectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ assetId, label }) => assets.rename(assetId, label),
    meta: { action: 'Renaming photo', handledLocally: true },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['assets', projectId] }),
  });
}

export function useDeleteAsset(projectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (assetId) => assets.remove(assetId),
    meta: { action: 'Deleting photo', handledLocally: true },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['assets', projectId] }),
  });
}

export function useDuplicateAsset(projectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (assetId) => assets.duplicate(assetId),
    meta: { action: 'Duplicating photo', handledLocally: true },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['assets', projectId] }),
  });
}
