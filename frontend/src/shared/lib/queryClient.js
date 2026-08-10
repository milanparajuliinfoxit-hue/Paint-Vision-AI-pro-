import { QueryClient, QueryCache, MutationCache } from '@tanstack/react-query';
import { reportError } from './errorReporter';

// TanStack Query owns all server state (projects, assets, layers, history,
// concepts, exports) — Zustand stores stay limited to ephemeral editor state
// (requirements doc, Section 11). A short staleTime keeps the workspace from
// refetching on every focus change while still picking up autosave writes.
//
// The caches carry a global onError because most writes here are
// fire-and-forget (`mutate()` from the undo/redo command stack, history
// appends): without it a rejected request resolved to nothing at all — no
// toast, no console entry — and the canvas kept showing an optimistic state
// the server had rejected. Callers that handle their own errors (upload,
// export, project create) still do; this is the backstop for the ones that
// don't. `meta.action` names the operation in the message.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
  queryCache: new QueryCache({
    onError: (error, query) => {
      reportError(error, { action: query.meta?.action || `Loading ${describeKey(query.queryKey)}` });
    },
  }),
  mutationCache: new MutationCache({
    onError: (error, _vars, _ctx, mutation) => {
      if (mutation.options.meta?.handledLocally) return;
      reportError(error, { action: mutation.options.meta?.action || 'Saving change' });
    },
  }),
});

function describeKey(queryKey) {
  return Array.isArray(queryKey) ? String(queryKey[0]) : String(queryKey);
}
