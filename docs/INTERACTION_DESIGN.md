# Interaction Design Specification: AI-Assisted Wall Detection & Repaint

**Module**: Paint Visualizer UX / Interactive Canvas  
**Status**: Figma-Level Design & Interaction Spec  

---

## 1. User Journey & Core Flow

```
[ Room Photo Uploaded ]
          │
          ▼
[ Select "AI Wall" Tool ] ──► (Hovering photo shows subtle region outline)
          │
          ▼
[ Tap Anywhere on Wall ] ──► (Instant shimmer / loading state < 1.5s)
          │
          ▼
[ Translucent Mask + Glowing Outline Rendered ]
          │
          ├───► [ Tap Refine "+ / -" or Edge Brush ] ──► (Live mask adjustment)
          ├───► [ Tap "Merge All Walls" ] ─────────────► (Combine plane masks)
          │
          ▼
[ Select Swatch from Bottom/Side Palette ] ──► (Instant recolor preview < 100ms)
          │
          ▼
[ Select Finish: Matte / Eggshell / Satin / Gloss ]
          │
          ▼
[ Click "Apply to Layer" ] ──► (Pushed to undo/redo stack & layer list)
```

---

## 2. Component Layout & Touch Guidance

### Desktop & Mobile Layout
- **Toolbar Item**: Dedicated `AI Wall` button with `Wand2` / `Paintbrush` icon and keyboard shortcut `W`.
- **Floating Refine Bar**:
  - Appears automatically over bottom-center canvas when an AI wall mask is active.
  - Buttons: `Select (+)` | `Remove (-)` | `Brush` | `Merge Walls` | `Finish: Satin ▼` | `Apply`.
  - All touch targets strictly **≥ 44px × 44px**.

### Visual States & Micro-Animations
1. **Hover State**:
   - Subtle pulse ring (2px solid `#3b82f6` with 30% opacity) following cursor over wall surfaces.
2. **Loading State**:
   - Animated shimmer overlay (`rgba(59, 130, 246, 0.15)`) across detected bounding region during server inference.
3. **Active Selection State**:
   - Translucent blue overlay (`rgba(59, 130, 246, 0.35)`) with animated SVG edge glow filter (`drop-shadow(0 0 6px rgba(59, 130, 246, 0.8))`).
4. **Recolored State**:
   - Realistic lighting-preserved color blend displaying shadows, highlights, and wall texture.

---

## 3. Undo/Redo & History Management

- **Independent History Stacks**:
  - **Mask Edits Stack**: Point additions, point subtractions, brush strokes, plane merges.
  - **Color/Finish Stack**: Palette swatch changes, custom hex edits, finish selector changes.
- Pressing `Ctrl+Z` / `Undo` in AI Wall mode undoes the last point prompt without losing chosen color swatch.
