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

  // Stores only the fields a swatch needs so the persisted list stays small
  // and every caller records the same shape.
  const markRecentlyUsed = useCallback((paint) => {
    const entry = {
      id: paint.id,
      color_name: paint.color_name,
      color_code: paint.color_code,
      hex_value: paint.hex_value,
    };
    setRecentPaints((prev) => [entry, ...prev.filter((p) => p.id !== entry.id)].slice(0, RECENT_LIMIT));
  }, []);

  return {
    favoriteIds,
    recentPaints,
    isFavorite: (id) => favoriteIds.has(id),
    toggleFavorite,
    markRecentlyUsed,
  };
}
