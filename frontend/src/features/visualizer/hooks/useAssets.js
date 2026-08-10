import { useQuery } from '@tanstack/react-query';
import { assets } from '../../../shared/lib/api';
import { useInvalidatingMutation } from '../../../shared/lib/useInvalidatingMutation';

const assetsKey = (projectId) => ['assets', projectId];

export function useAssetsList(projectId) {
  return useQuery({
    queryKey: assetsKey(projectId),
    queryFn: () => assets.list(projectId),
    enabled: !!projectId,
  });
}

export function useUploadAsset(projectId) {
  return useInvalidatingMutation((file) => assets.upload(projectId, file), assetsKey(projectId));
}

export function useCleanAsset(projectId) {
  return useInvalidatingMutation(
    ({ assetId, maskBlob }) => assets.clean(assetId, maskBlob),
    assetsKey(projectId)
  );
}

export function useRenameAsset(projectId) {
  return useInvalidatingMutation(
    ({ assetId, label }) => assets.rename(assetId, label),
    assetsKey(projectId)
  );
}

export function useDeleteAsset(projectId) {
  return useInvalidatingMutation((assetId) => assets.remove(assetId), assetsKey(projectId));
}

export function useDuplicateAsset(projectId) {
  return useInvalidatingMutation((assetId) => assets.duplicate(assetId), assetsKey(projectId));
}
