import { useCallback, useEffect, useState } from 'react';

const FAVORITES_KEY = 'catalog-favorites';
const RECENT_KEY = 'catalog-recently-used';
const RECENT_LIMIT = 8;

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

// Favorites/recently-used are spec'd as "per-user, persisted" (requirements
// doc, Section 6.1) — there's no auth in this app (per-project decision), so
// this is per-browser via localStorage instead of a server-side user table.
// Recent entries store a lightweight paint snapshot (not just an id) so the
// rail can render swatches without an extra lookup against whatever page/
// filter the main grid currently has loaded.
export function useFavorites() {
  const [favoriteIds, setFavoriteIds] = useState(() => new Set(readJson(FAVORITES_KEY, [])));
  const [recentPaints, setRecentPaints] = useState(() => readJson(RECENT_KEY, []));

  useEffect(() => {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favoriteIds]));
  }, [favoriteIds]);

  useEffect(() => {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentPaints));
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
