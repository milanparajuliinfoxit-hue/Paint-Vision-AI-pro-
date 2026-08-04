# IMPLEMENTATION_PLAN — AI Understanding Pipeline completion

Branch: `feat/ai-house-understanding` (base `dev`)
This plan implements the missing pieces identified in `ROOT_CAUSE_ANALYSIS.md`. Order matters: schema/idempotency first, then concept gallery, then semantic painting. Each phase ends with a verification step.

Non-goals (from audit): no rewrites of `colorEngine.js`/`LayerNode.jsx`; no second paint path; no real-model CV integration (out of scope); railings/columns not added.

---

## Phase 1 — AI layer dedup / idempotency (Critical)

### 1.1 Schema: `layers.ai_analysis_id` + `layers.ai_scheme_id`
`backend/src/sql/schema.sql`:
```sql
ALTER TABLE layers ADD COLUMN ai_analysis_id INT NULL AFTER ai_surface_key;
ALTER TABLE layers ADD COLUMN ai_scheme_id   INT NULL AFTER ai_analysis_id;
ALTER TABLE layers ADD UNIQUE INDEX uq_layers_ai_surface (ai_analysis_id, ai_surface_key);
```
- The unique index applies only to AI rows (`ai_surface_key NOT NULL` rows; `NULL` values are not constrained by UNIQUE in MySQL).
- `backend/src/scripts/runSchema.js`: add the two columns to the upgrade list. Keep the existing idempotent `columnExists`/`addColumn` pattern used for earlier columns.

### 1.2 Server upsert — `backend/src/services/layers.model.js`
Add `upsertAiLayer({ projectId, assetId, name, aiSurfaceKey, aiAnalysisId, aiSchemeId, colorId, orderIndex, maskPath })`:
1. `INSERT INTO layers (…) VALUES (…) ON DUPLICATE KEY UPDATE
   current_color_id = VALUES(current_color_id), order_index = VALUES(order_index), updated_at = NOW()`
   (dedup + color/scheme refresh on re-apply in one statement).
2. Return the id via `result.insertId` (MySQL with `ON DUPLICATE KEY UPDATE` returns `insertId` = existing row id when an update path is taken).

### 1.3 Controller — `backend/src/controllers/layers.controller.js`
- `createLayer` currently forwards to `layersModel.createLayer`. Add: when `req.body.createdVia === 'ai-surface'` and `aiSurfaceKey` is present, call `upsertAiLayer` instead. Pass through `aiAnalysisId`, `aiSchemeId`.
- Response semantics: 200 with `{ok:true, layerId, updated:true}` on dedup-update (idempotent re-apply), 201 on fresh insert. Frontend treats both as success (react-query invalidates anyway).

### 1.4 Client — `frontend/src/features/visualizer/hooks/useApplySurface.js`
- `applySurface(surface)` → include `aiAnalysisId` (from `surface.analysis_id` / the loaded analysis job id).
- `applyScheme(scheme)` → include `aiAnalysisId` + `aiSchemeId` (from the scheme record).
- Guard: if the surface is already applied (its layer id already in the applied set for this analysis), still send (server dedups); but avoid creating duplicate **history entries** by reusing the existing layer id.
- `useApplyColor.js` PATCH path already only touches `current_color_id` — unaffected.

### 1.5 History noise
- `useApplySurface.js` currently always pushes a history commit. Only push a new commit when the layer is newly created (`201`); on `200/updated` no new history entry (the color change is already visible via renderer).

### 1.6 Data cleanup (temp script — NOT committed)
In `backend/src/scripts/` run a one-off local script (then delete):
- For asset `578a49c5-e432-4561-baf6-9ea1825f91d5`, soft-delete layers 361–367 (the duplicate scheme batch) keeping 356–360; then backfill `ai_analysis_id` on remaining AI layers by matching `ai_surface_key` to the analysis in `ai_jobs`/`detected_surfaces`.
- Verify: `SELECT COUNT(*) FROM layers WHERE ai_analysis_id IS NULL AND ai_surface_key IS NOT NULL` → 0.

**Verify Phase 1**: `node backend/scripts/runSchema.js`; backend smoke: analyze asset → apply scheme twice → `GET layers` shows same layer ids, no new rows, layer count stable.

---

## Phase 2 — Rendered concept gallery + persistence (Critical)

### 2.1 Shared image-load helper (dedupe 5.5)
Create `frontend/src/shared/lib/maskImage.js` exporting `loadAlphaGrid`, `maskToCanvas`, `surfaceMaskToPngBlob`; refactor `useAiAnalysis.js`, `VisualizerWorkspace.jsx`, `useApplySurface.js` to import from it (no behavior change).

### 2.2 Preview composer — `frontend/src/features/visualizer/lib/renderSchemePreview.js`
- Input: full-size `baseImageData` (from `useImageElement` MAX_DIMENSION 1600 image — same source as `LayerNode`), scheme surfaces (detected surfaces each with `mask_path`), scheme paint colors.
- Output: an HTMLCanvasElement.
- Algorithm:
  1. `baseCanvas = document.createElement('canvas')`, draw base image.
  2. For each surface (sorted by geometry depth: roof/trim/gutter → left/right walls → front wall → windows/doors last), load mask PNG → alpha grid → upscale to base canvas size → `applyPaintColor(baseImageData, maskData, schemeRgb, 0.95, {lightnessBlend:0.45})` exactly as `LayerNode.jsx:43`.
  3. Composite results bottom-up (later draws on top). This matches layer stacking order in `CanvasStage.jsx` (surface layers then obstacle layers).
- This is a **batch preview**, not a new renderer — it reuses `colorEngine` and the same call signature the layer nodes use.

### 2.3 UI — `frontend/src/features/visualizer/panels/RecommendationsTab.jsx`
- Replace swatch-strip-only with a rendered **preview card grid** (5–10 schemes): each card = `<canvas>` thumbnail produced by the composer (async, memoized per scheme).
- Card actions: **Apply** (existing `applyScheme`, keeps behavior) and **Save as concept**.
- On `currentAnalysis`/schemes change, rebuild previews; cancel in-flight preview work on unmount/refresh.

### 2.4 Persist — existing `concepts` API
- `POST /api/projects/:projectId/concepts` already accepts `{name, thumbnail, layerColorMap}` (`concepts.controller.js`). Add **Save as concept**: build `layerColorMap` from scheme (`{surfaceClass: paintId}`), thumbnail = preview canvas scaled to ~256px → `toDataURL`/File → existing `concepts.create` (it already handles thumbnail upload — verify `concepts.model.js`).
- If needed, add `GET /api/projects/:projectId/concepts` (list with thumbnails) and an "apply concept" path:
  - `useApplyConcept.js`: given a concept's `layerColorMap` + asset surfaces, reuse `useApplySurface.applyScheme`-equivalent (one `layers.create` per mapped surface) so a concept re-applies as **editable layers**, not a static picture.

### 2.5 Concept gallery UI — `AssetsTab.jsx`
- Concept list already exists (`AssetsTab.jsx:52`, `conceptsApi.list`). Add "Save as concept" from RecommendationsTab and a gallery section in AssetsTab listing saved concepts with **Apply** (→ editable layers) and **Delete** (existing delete API — verify).

**Verify Phase 2**: frontend `npm run build`; manual: analyze → recommendations → previews render → Save as concept → appears in AssetsTab → Apply concept → layers created & renderer paints; DB row in `concepts` with thumbnail.

---

## Phase 3 — Semantic surface painting (High)

### 3.1 Click-to-pick surface — `VisualizerWorkspace.jsx` + `CanvasStage.jsx`
- New editor tool `surface-pick` in `toolDefs.js`: cursor crosshair; on pointerdown over canvas, hit-test the **analysis masks** (from `useAssetAnalysis` — the per-pixel alpha grids already loaded for brush refine).
- Hit-test: point → topmost paintable surface whose mask alpha>128 at that pixel. Implement `pickSurfaceAtPoint(masks, {x,y}, scale)` in `maskOps.js`.
- Selection result: set `selectedSurface` in Zustand; `AIAnalyzeTab` highlights it; show a small floating "Paint whole surface" affordance (or auto-open color picker via existing `useApplyColor`).
- Apply: reuse Phase-1 `upsertAiLayer` (no duplicate).

### 3.2 Explicit mask-refine modes — `VisualizerWorkspace.jsx`/`toolDefs.js`
- Add `Add` / `Remove` / `Erase` toggle for brush on an AI-surface layer:
  - Add = paint mask alpha up (existing `rasterizeBrushStroke` add path).
  - Remove = subtract (existing Alt path, now an explicit toggle).
  - Eraser = restore original analysis mask (store `originalMask` snapshot on layer create; eraser restores alpha from snapshot within stroke).
- `surfaceAwareBrushStroke` + `clipMaskToConstraint` already gate edits to the AI surface — keep.

### 3.3 Batch undo for "Clear all paint"
- `visualizerStore.js`: add `clearAllPaint()` → sets each AI-surface layer color back to `null` (or original), one history commit. Wire a button in the Layers/Inspector header.

**Verify Phase 3**: build + manual: pick tool clicks wall → layer created for the whole surface; brush in Remove mode erases but never paints outside the surface; Clear all paint restores base image; undo restores paint.

---

## Phase 4 — Verification, docs, commit

1. Backend smoke (as in Phase 1) + `GET /api/meta`, 404/403/409 error paths.
2. Frontend `npm run build` (vite build, no type errors).
3. Confirm `image.png` remains untracked; never staged.
4. Commit message (repo style — check `git log`): `feat(ai): idempotent ai layers, rendered scheme previews, concept gallery, semantic painting`.
5. Keep `ROOT_CAUSE_ANALYSIS.md`, `IMPLEMENTATION_PLAN.md`, `ARCHITECTURE_DIAGRAM.md`, `AI_PIPELINE.md` in the commit.

---

## Risk register

| Risk | Mitigation |
|---|---|
| `ON DUPLICATE KEY UPDATE` returns wrong id on update path | Verified behavior in MySQL; use `insertId`; fall back to `SELECT id` if ambiguous in tests |
| Preview color differs from final render | Preview composer reuses the exact `applyPaintColor` args from `LayerNode.jsx:43` |
| Unique index blocks legitimate two-layer same-surface cases | No such case exists in product logic (one layer per surface per analysis) |
| Stale mask cache after edits | Reuse existing invalidation path `VisualizerWorkspace.jsx:112-156` |
| Backfill script safety | Run on dev DB only, soft-delete (not hard), transaction-wrapped, never committed |

## Definition of Done
- Re-applying a scheme/analysis creates **zero** duplicate rows; re-apply updates color in place.
- Recommendations show rendered thumbnails; Save-as-concept persists and re-applies as editable layers.
- Clicking a detected surface selects it and paints the whole surface; brush refinement never escapes the surface.
- All existing features (upload, layers, history, export, catalog, color engine) continue to work.
