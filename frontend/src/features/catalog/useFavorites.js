import { useCallback, useEffect, useState } from 'react';
import { readJson, writeJson } from '../../shared/lib/localStore';

const FAVORITES_KEY = 'catalog-favorites';
const RECENT_KEY = 'catalog-recently-used';
const RECENT_LIMIT = 8;

// Favorites/recently-used are spec'd as "per-user, persisted" (requirements
// doc, Section 6.1) — there's no auth in this app (per-project decision), so
// this is per-browser via localStorage instead of a server-side user table.
// Recent entries store a lightweight paint snapshot (not just an id) so the
// rail can render swatches without an extra lookup against whatever page/
// filter the main grid currently has loaded.
export function useFavorites() {
  const [favoriteIds, setFavoriteIds] = useState(() => new Set(readJson(FAVORITES_KEY, [])));
  const [recentPaints, setRecentPaints] = useState(() => readJson(RECENT_KEY, []));

  // These writes ran bare inside an effect: a quota error threw out of the
  // effect (React logs it and moves on) and the user never learned their
  // favorites had stopped persisting.
  useEffect(() => {
    writeJson(FAVORITES_KEY, [...favoriteIds]);
  }, [favoriteIds]);

  useEffect(() => {
    writeJson(RECENT_KEY, recentPaints);
  }, [recentPaints]);

  const toggleFavorite = useCallback((paintId) => {
    setFavoriteIds((prev) => {
      const next = new Set(prev);
      if (next.has(paintId)) next.delete(paintId);
      else next.add(paintId);
      return next;
    });
  }, []);

  const markRecentlyUsed = useCallback((paint) => {
    setRecentPaints((prev) => [paint, ...prev.filter((p) => p.id !== paint.id)].slice(0, RECENT_LIMIT));
  }, []);

  return {
    favoriteIds,
    recentPaints,
    isFavorite: (id) => favoriteIds.has(id),
    toggleFavorite,
    markRecentlyUsed,
  };
}
