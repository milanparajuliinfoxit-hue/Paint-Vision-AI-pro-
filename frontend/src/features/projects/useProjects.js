import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { projects } from '../../shared/lib/api';

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
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data) => projects.create(data),
    meta: { action: 'Creating project', handledLocally: true },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });
}

export function useUpdateProject(projectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ patch, updatedAt }) => projects.update(projectId, patch, updatedAt),
    meta: { action: 'Saving project' },
    onSuccess: (updated) => {
      queryClient.setQueryData(['project', projectId], updated);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}
