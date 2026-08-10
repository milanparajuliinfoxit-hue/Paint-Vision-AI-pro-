import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { history } from '../../../shared/lib/api';

export function useHistoryList(projectId) {
  return useQuery({
    queryKey: ['history', projectId],
    queryFn: () => history.list(projectId),
    enabled: !!projectId,
  });
}

export function useAppendHistory(projectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (entry) => history.append(projectId, entry),
    meta: { action: 'Recording history entry' },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['history', projectId] }),
  });
}
