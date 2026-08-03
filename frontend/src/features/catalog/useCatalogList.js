import { useQuery } from '@tanstack/react-query';
import { catalog } from '../../shared/lib/api';

// Shared across CatalogPage and the Visualizer's color panels — one cached
// fetch instead of each consumer re-requesting the same 2000+ rows.
export function useCatalogList(params = {}) {
  return useQuery({
    queryKey: ['catalog', params],
    queryFn: () => catalog.list(params),
    staleTime: 60_000,
  });
}
