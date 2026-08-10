import { useMutation, useQueryClient } from '@tanstack/react-query';

// Most mutations in this app do the same thing on success: refetch the one
// list the mutated row belongs to. This keeps that wiring in one place so
// feature hooks only declare the request and the key it affects.
export function useInvalidatingMutation(mutationFn, queryKey, options = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    ...options,
    onSuccess: (...args) => {
      queryClient.invalidateQueries({ queryKey });
      return options.onSuccess?.(...args);
    },
  });
}
