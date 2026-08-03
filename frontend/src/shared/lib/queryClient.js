import { QueryClient } from '@tanstack/react-query';

// TanStack Query owns all server state (projects, assets, layers, history,
// concepts, exports) — Zustand stores stay limited to ephemeral editor state
// (requirements doc, Section 11). A short staleTime keeps the workspace from
// refetching on every focus change while still picking up autosave writes.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
