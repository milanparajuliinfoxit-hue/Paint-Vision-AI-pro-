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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });
}

export function useUpdateProject(projectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ patch, updatedAt }) => projects.update(projectId, patch, updatedAt),
    onSuccess: (updated) => {
      queryClient.setQueryData(['project', projectId], updated);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

// Best-effort bookmark of the local undo stack's position (see backend
// projects.model.js's setUndoPointer) — updates the cache directly instead
// of invalidating so rapid undo/redo/jump clicks don't each trigger a
// project refetch.
export function useSetUndoPointer(projectId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pointer) => projects.setUndoPointer(projectId, pointer),
    onSuccess: (updated) => queryClient.setQueryData(['project', projectId], updated),
  });
}

export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId) => projects.remove(projectId),
    onSuccess: (_deleted, projectId) => {
      queryClient.removeQueries({ queryKey: ['project', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}
