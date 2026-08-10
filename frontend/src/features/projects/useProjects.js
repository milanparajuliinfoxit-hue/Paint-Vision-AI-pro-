import { useQuery, useQueryClient } from '@tanstack/react-query';
import { projects } from '../../shared/lib/api';
import { useInvalidatingMutation } from '../../shared/lib/useInvalidatingMutation';

export function useProjectsList(params = {}) {
  return useQuery({
    queryKey: ['projects', params],
    queryFn: () => projects.list(params),
  });
}

export function useProject(projectId) {
  return useQuery({
    queryKey: ['project', projectId],
    queryFn: () => projects.get(projectId),
    enabled: !!projectId,
  });
}

export function useCreateProject() {
  return useInvalidatingMutation((data) => projects.create(data), ['projects']);
}

export function useUpdateProject(projectId) {
  const queryClient = useQueryClient();
  return useInvalidatingMutation(
    ({ patch, updatedAt }) => projects.update(projectId, patch, updatedAt),
    ['projects'],
    { onSuccess: (updated) => queryClient.setQueryData(['project', projectId], updated) }
  );
}
