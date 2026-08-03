import { useEffect, useRef } from 'react';
import { get, set } from 'idb-keyval';
import { useVisualizerStore } from '../store/visualizerStore';
import { debounce } from '../../../shared/lib/debounce';

const DRAFT_FIELDS = ['viewport', 'activeTool', 'activeAssetId', 'activeLayerId', 'brushMode', 'brushSize'];

function draftKey(projectId) {
  return `visualizer-draft:${projectId}`;
}

// Mirrors editor viewport/tool state to IndexedDB per project so a refresh
// restores the workspace instantly instead of a blank canvas while the
// project/layers refetch catches up (requirements doc, Section 7).
export function useIndexedDraft(projectId) {
  const restored = useRef(false);

  useEffect(() => {
    if (!projectId || restored.current) return;
    restored.current = true;
    get(draftKey(projectId)).then((draft) => {
      if (!draft) return;
      useVisualizerStore.setState((state) => ({ ...state, ...draft }));
    });
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return undefined;
    const persist = debounce((state) => {
      const draft = {};
      for (const field of DRAFT_FIELDS) draft[field] = state[field];
      set(draftKey(projectId), draft);
    }, 400);

    const unsubscribe = useVisualizerStore.subscribe(persist);
    return () => {
      unsubscribe();
      persist.cancel();
    };
  }, [projectId]);
}
