import { useCallback, useEffect, useState } from 'react';

const COLLECTIONS_KEY = 'catalog-collections';

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function uid() {
  return `col_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Curated color groups (e.g. "Neutrals", "Client A shortlist") — like
// favorites, there's no auth in this app, so collections live per-browser in
// localStorage rather than a server-side table.
export function useCollections() {
  const [collections, setCollections] = useState(() => readJson(COLLECTIONS_KEY, []));

  useEffect(() => {
    localStorage.setItem(COLLECTIONS_KEY, JSON.stringify(collections));
  }, [collections]);

  const createCollection = useCallback((name) => {
    const collection = { id: uid(), name: name.trim() || 'Untitled collection', paintIds: [] };
    setCollections((prev) => [...prev, collection]);
    return collection.id;
  }, []);

  const renameCollection = useCallback((id, name) => {
    setCollections((prev) => prev.map((c) => (c.id === id ? { ...c, name: name.trim() || c.name } : c)));
  }, []);

  const deleteCollection = useCallback((id) => {
    setCollections((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const togglePaintInCollection = useCallback((id, paintId) => {
    setCollections((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        const has = c.paintIds.includes(paintId);
        return { ...c, paintIds: has ? c.paintIds.filter((p) => p !== paintId) : [...c.paintIds, paintId] };
      })
    );
  }, []);

  return { collections, createCollection, renameCollection, deleteCollection, togglePaintInCollection };
}
