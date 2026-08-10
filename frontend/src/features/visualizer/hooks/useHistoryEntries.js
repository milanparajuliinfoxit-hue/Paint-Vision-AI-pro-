import { useQuery } from '@tanstack/react-query';
import { history } from '../../../shared/lib/api';
import { useInvalidatingMutation } from '../../../shared/lib/useInvalidatingMutation';

const historyKey = (projectId) => ['history', projectId];

export function useHistoryList(projectId) {
  return useQuery({
    queryKey: historyKey(projectId),
    queryFn: () => history.list(projectId),
    enabled: !!projectId,
  });
}

export function useAppendHistory(projectId) {
  return useInvalidatingMutation((entry) => history.append(projectId, entry), historyKey(projectId));
}
