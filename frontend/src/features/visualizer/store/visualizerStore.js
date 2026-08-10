import { create } from 'zustand';

// Ephemeral editor state only — active tool, viewport, in-progress mask,
// undo pointer. Server state (projects/assets/layers/history) lives in
// TanStack Query, never here (requirements doc, Section 11's boundary rule).
export const useVisualizerStore = create((set, get) => ({
  activeTool: 'rect',
  brushMode: 'mask-edit', // 'mask-edit' | 'direct-paint'
  // Explicit brush mask-refine polarity: 'add' grows a layer's mask, 'remove'
  // shrinks it (the eraser tool always removes). Alt inverts on the fly.
  maskRefineMode: 'add',
  brushSize: 60,
  magicWandTolerance: 24,

  // Surface-aware brush: clips the brush footprint to the architectural
  // surface under the stroke (stops at railings, frames, glass, sky/ground
  // seams). On by default — it's the painting mode that makes the tool feel
  // like painting a building rather than coloring an image.
  surfaceAware: true,
  surfaceTolerance: 22,

  // AI surface lock: when on (and the active layer came from AI analysis —
  // it carries an ai_surface_key), brush strokes are additionally clipped to
  // the detected surface mask, so paint physically cannot escape the surface
  // the AI identified. Defaults on; off for freehand refinement.
  // AI Wall Detection & Finish Simulator State
  aiWallFinish: 'satin', // 'matte' | 'eggshell' | 'satin' | 'gloss'
  aiWallRefineMode: 'add', // 'add' | 'remove' | 'brush'
  aiWallPositivePoints: [],
  aiWallNegativePoints: [],
  aiWallActiveMask: null,
  aiWallHoverPoint: null,
  aiWallIsSegmenting: false,

  viewport: { scale: 1, x: 0, y: 0 },

  activeAssetId: null,
  activeLayerId: null,
  // True only when the dealer deliberately picked this layer via the
  // Layers/Finishes panel (selectLayer). setActiveLayerId also activates a
  // layer as the *implicit* paint-continuation target right after it's
  // created (handleCommitMask, useApplySurface, useConcepts) — that must
  // NOT be treated as "the dealer chose this layer to recolor," or picking
  // a catalog color for the *next* stroke would retroactively repaint
  // whatever was just painted (the reported color-bleed bug). Only this
  // flag, not activeLayerId alone, authorizes useApplyColor's recolor-the-
  // active-layer side effect.
  layerSelectedExplicitly: false,

  // The catalog color currently selected for painting — direct-paint brush
  // strokes and new layers apply this; hover-preview (Section 6.1) reads it
  // too without committing until click.
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
  setMaskRefineMode: (mode) => set({ maskRefineMode: mode }),
  setBrushSize: (size) => set({ brushSize: size }),
  setMagicWandTolerance: (tolerance) => set({ magicWandTolerance: tolerance }),
  setSurfaceAware: (on) => set({ surfaceAware: on }),
  setSurfaceTolerance: (tolerance) => set({ surfaceTolerance: tolerance }),
  setAiSurfaceLock: (on) => set({ aiSurfaceLock: on }),
  setViewport: (viewport) => set({ viewport }),
  setActiveAssetId: (id) => set({ activeAssetId: id, activeLayerId: null, layerSelectedExplicitly: false }),
  // Implicit activation — paint-continuation target, not a deliberate pick.
  setActiveLayerId: (id) => set({ activeLayerId: id, layerSelectedExplicitly: false }),
  // Deliberate activation — the dealer clicked this layer in the
  // Layers/Finishes panel, so it's a legitimate target for useApplyColor's
  // "apply this catalog color to the selected layer" behavior.
  selectLayer: (id) => set({ activeLayerId: id, layerSelectedExplicitly: true }),
  setPendingColor: (colorId, rgb) => set({ pendingColorId: colorId, pendingColorRgb: rgb }),
  setHoverPreviewColorRgb: (rgb) => set({ hoverPreviewColorRgb: rgb }),
  setInProgressMaskCanvas: (canvas) => set({ inProgressMaskCanvas: canvas }),
  setCompareMode: (mode) => set({ compareMode: mode }),
  setCompareState: (state) => set({ compareState: state }),
  setImageLocked: (locked) => set({ imageLocked: locked }),
  requestFit: () => set((s) => ({ fitSignal: s.fitSignal + 1 })),

  setAiWallFinish: (finish) => set({ aiWallFinish: finish }),
  setAiWallRefineMode: (mode) => set({ aiWallRefineMode: mode }),
  setAiWallActiveMask: (mask) => set({ aiWallActiveMask: mask }),
  setAiWallHoverPoint: (pt) => set({ aiWallHoverPoint: pt }),
  setAiWallIsSegmenting: (isSeg) => set({ aiWallIsSegmenting: isSeg }),
  addAiWallPoint: (pt, isPositive = true) =>
    set((state) => ({
      aiWallPositivePoints: isPositive ? [...state.aiWallPositivePoints, pt] : state.aiWallPositivePoints,
      aiWallNegativePoints: !isPositive ? [...state.aiWallNegativePoints, pt] : state.aiWallNegativePoints,
    })),
  clearAiWallPoints: () => set({ aiWallPositivePoints: [], aiWallNegativePoints: [], aiWallActiveMask: null }),

  // Seed the stack from persisted history on load. `pointer` is the
  // project's persisted undo_pointer — the log itself is append-only and
  // never records an undo/redo, so without it the only fallback is
  // "everything in the log is applied," which is wrong for any project
  // with an undo that wasn't followed by a redo before the last reload.
  hydrateHistory: (entries, pointer) =>
    set({ undoStack: entries, undoPointer: Math.min(pointer ?? entries.length - 1, entries.length - 1) }),

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
