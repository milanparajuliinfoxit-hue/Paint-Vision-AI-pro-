# AI_PIPELINE — how image understanding reaches the screen

Operator view of the AI House Understanding pipeline, end to end, with the exact files that implement each stage.

## Stage 1 — Upload
- File: `frontend/src/features/visualizer/panels/AssetsTab.jsx` → `frontend/src/shared/lib/api.js` (`assets.upload`)
- Backend: `backend/src/routes/assets.routes.js` → `assets.controller.js` → `storage.service.js`
- Result: row in `assets`, source image on disk under `uploads/<projectId>/<assetId>/`.

## Stage 2 — Analysis ("AI Understand")
- Trigger: **AI Understand** tab button → `POST /api/assets/:id/ai/analyze`
- Files: `backend/src/controllers/ai.controller.js` → `backend/src/services/ai/houseUnderstanding.service.js` → `aiRegistry.service.js` → provider
- Providers:
  - `mockProvider.js` — heuristic segmenter (Jimp: LAB color distance, connected components, bbox, roof split, trim/gutter dilation, region-grow obstacles). Labeled "Developer Mock", i.e. a real image-pipeline stand-in for a future learned model. Configured via `AI_ANALYSIS_PROVIDER=mock`.
  - `httpVisionProvider.js` — optional real-model path (`AI_VISION_URL`), same output contract.
- Output (stored):
  - `ai_jobs` — one row per run (`status`, `confidence`, `processing_time_ms`, `output_json`).
  - `detected_surfaces` — paintable regions: `front-wall`, `left-wall`, `right-wall`, `roof`, `trim`, `gutter`, plus obstacles `door`, `window`, `door-frame`.
  - `detected_objects` — obstacles (each non-paintable).
  - Masks as alpha PNGs under `uploads/<assetId>/ai/<surfaceKey>.png`; `mask_path` column references them.

## Stage 3 — Recommendations ("AI Schemes")
- Trigger: **AI Schemes** tab → `POST /api/assets/:id/ai/recommendations`
- Files: `backend/src/services/ai/paintRecommendation.service.js` → `aiRegistry.service.js` → `catalogRecommendationProvider.js`
- Input: latest successful analysis; **catalog only** (`paints` table) — never hardcoded paint ids. Target HSL rules → each role scored by LAB distance → top-6 (`AI_RECOMMENDATION_COUNT`, clamped 1–10).
- Output: `paint_recommendations` rows + `scheme_json` (`{surfaceClass, role, paintId}`); previous batch cleared first.

## Stage 4 — Preview & select (Phase 2)
- `frontend/src/features/visualizer/lib/renderSchemePreview.js` composes thumbnails: full-size base image + per-surface masks + `colorEngine.applyPaintColor` with the exact args `LayerNode` uses — so preview == final render.
- `RecommendationsTab.jsx` renders the preview card grid.

## Stage 5 — Layer creation (Phase 1, idempotent)
- Trigger: Apply scheme / surface → `frontend/src/features/visualizer/hooks/useApplySurface.js`
- Request: `POST /api/layers` with `createdVia='ai-surface'`, `aiSurfaceKey`, `aiAnalysisId`, `aiSchemeId`, `currentColorId`, mask blob.
- Backend: `layers.controller.js` → `layers.model.upsertAiLayer` — `INSERT … ON DUPLICATE KEY UPDATE` under unique index `(ai_analysis_id, ai_surface_key)`. Re-apply updates color in place, **never duplicates**.

## Stage 6 — Render
- `frontend/src/features/visualizer/canvas/CanvasStage.jsx` maps layers → `LayerNode.jsx`.
- `LayerNode.jsx` loads `baseImageData` + mask + color → `applyPaintColor` (`colorEngine.js`) → composited `<canvas>` → Konva.
- Changing `current_color_id` re-renders via react-query optimistic patch + effect deps. This is the only paint path in the app.

## Stage 7 — Concepts (Phase 2)
- Save: `RecommendationsTab` **Save as concept** → `POST /api/projects/:projectId/concepts` (`{name, thumbnail, layerColorMap}`) → `concepts` table.
- Gallery: `AssetsTab.jsx` lists saved concepts.
- Apply: `useApplyConcept` re-applies the concept's `layerColorMap` through Stage-5 (one layer per surface) → **editable, not a static image**.

## Stage 8 — Semantic editing (Phase 3)
- **Surface-pick tool**: pointerdown → hit-test analysis masks (`maskOps.pickSurfaceAtPoint`) → select surface → paint whole surface via Stage 5.
- **Brush refine**: brush strokes on an AI-surface layer are add/remove/erase of the mask; `clipMaskToConstraint` + `surfaceAwareBrushStroke` guarantee strokes never escape the surface; edits commit via `PATCH /api/layers/:id/mask`.
- **Clear all paint**: batch reset of AI-surface colors with one history entry.

## Environment
`.env` (backend, see `.env.example`): `AI_ANALYSIS_PROVIDER=mock`, `AI_RECOMMENDATION_PROVIDER=catalog`, `AI_ANALYSIS_MAX_DIM=640`, `AI_RECOMMENDATION_COUNT=6`, `AI_ANALYSIS_ENABLED=true`, `AI_RECOMMENDATION_ENABLED=true`.

## Failure modes
- Analyze without asset → 404. AI disabled → 403. Recommendations before any analysis → 409. Empty catalog → 409. Provider crash → job `status='failed'` + `failure_reason`, surfaced in the tab.
