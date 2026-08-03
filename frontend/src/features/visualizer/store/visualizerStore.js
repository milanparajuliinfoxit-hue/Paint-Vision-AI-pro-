import { create } from 'zustand';

// Ephemeral editor state only — active tool, viewport, in-progress mask,
// undo pointer. Server state (projects/assets/layers/history) lives in
// TanStack Query, never here (requirements doc, Section 11's boundary rule).
export const useVisualizerStore = create((set, get) => ({
  activeTool: 'rect',
  brushMode: 'mask-edit', // 'mask-edit' | 'direct-paint'
  brushSize: 60,
  magicWandTolerance: 24,

  viewport: { scale: 1, x: 0, y: 0 },

  activeAssetId: null,
  activeLayerId: null,

  // The catalog color currently selected for painting — bucket fill and
  // direct-paint brush strokes apply this; hover-preview (Section 6.1) reads
  // it too without committing until click.
  pendingColorId: null,
  pendingColorRgb: null,

  // Hover-preview (Section 6.1): applies to the active layer's canvas render
  // at <100ms without touching persisted state — cleared on mouse-leave,
  // only a click commits via setPendingColor + an actual layer PATCH.
  hoverPreviewColorRgb: null,

  // A mask the active tool is still drawing — committed into a real Layer
  // (via the layers API) only when the tool finishes (requirements doc,
  // Section 5.2: selection tools produce a mask, not an immediate paint).
  inProgressMaskCanvas: null,

  // Local undo/redo stack — each entry is {type, layerId, before, after}.
  // Mirrored to /projects/:id/history for persistence (useHistoryCommand),
  // but applying undo/redo itself is instant and fully local.
  undoStack: [],
  undoPointer: -1, // index of the last applied command; -1 = nothing applied

  // Compare + view options
  compareMode: null, // null | 'side-by-side' | 'slider' | 'split' | 'fade'
  compareState: 'painted', // 'original' | 'cleaned' | 'painted' — the primary state shown

  // Canvas view chrome (ephemeral)
  imageLocked: false, // disables pan/zoom so the photo stays put
  imageVisible: true, // hide/show the base photo
  fitSignal: 0, // bumping this asks CanvasStage to fit-to-screen again

  setActiveTool: (tool) => set({ activeTool: tool }),
  setBrushMode: (mode) => set({ brushMode: mode }),
  setBrushSize: (size) => set({ brushSize: size }),
  setMagicWandTolerance: (tolerance) => set({ magicWandTolerance: tolerance }),
  setViewport: (viewport) => set({ viewport }),
  setActiveAssetId: (id) => set({ activeAssetId: id, activeLayerId: null }),
  setActiveLayerId: (id) => set({ activeLayerId: id }),
  setPendingColor: (colorId, rgb) => set({ pendingColorId: colorId, pendingColorRgb: rgb }),
  setHoverPreviewColorRgb: (rgb) => set({ hoverPreviewColorRgb: rgb }),
  setInProgressMaskCanvas: (canvas) => set({ inProgressMaskCanvas: canvas }),
  setCompareMode: (mode) => set({ compareMode: mode }),
  setCompareState: (state) => set({ compareState: state }),
  setImageLocked: (locked) => set({ imageLocked: locked }),
  setImageVisible: (visible) => set({ imageVisible: visible }),
  requestFit: () => set((s) => ({ fitSignal: s.fitSignal + 1 })),

  // Seed the stack from persisted history on load (already-applied entries).
  hydrateHistory: (entries) => set({ undoStack: entries, undoPointer: entries.length - 1 }),

  pushCommand: (command) =>
    set((state) => ({
      // Pushing after an undo discards the redo tail, same as any editor.
      undoStack: [...state.undoStack.slice(0, state.undoPointer + 1), command],
      undoPointer: state.undoPointer + 1,
    })),

  canUndo: () => get().undoPointer >= 0,
  canRedo: () => get().undoPointer < get().undoStack.length - 1,

  moveUndoPointer: (delta) => set((state) => ({ undoPointer: state.undoPointer + delta })),
}));
