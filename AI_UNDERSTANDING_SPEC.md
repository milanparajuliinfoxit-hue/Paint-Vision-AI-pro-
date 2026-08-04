# AI House Understanding — Feature Specification

Branch: `feat/ai-house-understanding` · Base: `dev`

This document specifies the two AI capabilities added to the Paint Dealer Visualizer:

1. **Feature A — AI House Understanding (analysis)** — the AI understands a house photo as a
   structured scene: house → surfaces (paintable vs protected) → objects → context.
2. **Feature B — AI Paint Recommendations** — 5–10 complete paint schemes per request, each
   mapping every detected surface to a paint that exists in the catalog.

Both features follow the same platform rules: the AI *only produces structured understanding*;
the existing LAB rendering engine and layer pipeline stay authoritative for applying paint. The
AI never invents colors and never paints a non-paintable surface.

---

## Feature A — AI House Understanding

### 1. Objective
Analyze an uploaded house photo and produce a structured, explainable understanding of the
scene: whether a house is present, its architectural style/material/color, its paintable
surfaces (walls, roof, trim, gutters, doors), and its protected objects (windows, trees, cars,
neighbor houses). Everything the AI produces is metadata + mask files; nothing is painted.

### 2. Business Value
A paint dealer currently hand-draws every surface with rect/lasso/brush. House understanding
lets the dealer promote an entire house into layers in one click ("Add layer" per detected
surface) and grounds every downstream recommendation in an actual house, dramatically
shortening the path from photo → client-ready paint plan.

### 3. Technical Design
- Runs server-side (`POST /api/assets/:assetId/ai/analyze`) against the asset's photo.
- Provider-agnostic via a capability registry (`aiRegistry.service.js`): the capability
  `house-understanding` is bound to a provider by `AI_ANALYSIS_PROVIDER` (default `mock`).
- Every run writes a versioned, append-only `ai_jobs` row (provider, model version, confidence,
  processing time, failure reason, output summary) — the audit log that makes every AI result
  explainable and replaceable.
- Surfaces/objects persist in `detected_surfaces` / `detected_objects` (metadata + file
  reference); mask pixels are alpha PNGs on disk via `storage.service` (same pattern as layer
  masks). `paintable` is the hard guard the brush/apply flows read.
- Analysis runs on a downscaled copy (`AI_ANALYSIS_MAX_DIM`, default 640) to keep the request
  envelope small; masks are scaled back up to full resolution when promoted to layers.
- Feature-flag: `AI_ANALYSIS_ENABLED` (default true) — disabled deployments get a clear 403.

### 4. AI Design
- **mock provider** (`providers/mockProvider.js`, `mock-understanding-v1`): pure heuristic
  image understanding via `jimp` — sky/green classification, house bounding box, per-surface
  masks (roof, front/left/right walls, trim, gutters, windows, door), connected-component
  object detection (trees, obstacles, neighbor houses), context colors, style/material guesses,
  and a confidence per detection. Requires no API key and runs fully in-process.
- **http-vision provider** (`providers/httpVisionProvider.js`): POSTs the downscaled photo as a
  PNG data-URI to `AI_VISION_URL` (with `AI_VISION_API_KEY` / `AI_VISION_MODEL` /
  `AI_VISION_TIMEOUT_MS`) and validates the response against the same output schema the mock
  produces — providers are drop-in interchangeable.
- Every provider output is wrapped in the standardized envelope (`aiResult.js`): output,
  confidence, processing time, model version, provider, failure reason.
- The AI never decides colors — it reports average/context colors for the UI to reference.

### 5. Integration Strategy
- Mounted as sub-routes under the existing assets resource: `assets.routes.js` adds
  `router.use('/:assetId/ai', aiRoutes)` — the public path is
  `POST/GET /api/assets/:assetId/ai/analysis`.
- Runs after the existing photo lifecycle (upload, optional cleanup). Uses the same
  `storage.service` for masks and the same DB pool as every other module.
- The AI layer is a wrapper around stable modules (assets, layers, history) — it does not
  modify renderer, catalog, undo/redo, or export behavior.

### 6. Files to Modify
- `backend/src/routes/assets.routes.js` (mount AI sub-routes)
- `backend/src/app.js` (mount `/api/meta`)
- `backend/src/controllers/assets.controller.js` (AI mask cleanup on asset delete)
- `backend/src/scripts/runSchema.js` (additive upgrade column `layers.ai_surface_key`)
- `backend/src/sql/schema.sql` (new tables + column)
- `backend/src/services/layers.model.js` / `layers.controller.js` (`aiSurfaceKey` passthrough)
- `backend/.env.example` (AI env vars)
- `frontend/src/shared/lib/api.js` (`meta`, `ai` API groups; `aiSurfaceKey` on layers)
- `frontend/src/features/visualizer/store/visualizerStore.js` (`aiSurfaceLock`)
- `frontend/src/features/visualizer/tools/maskOps.js` (`clipMaskToConstraint`)
- `frontend/src/features/visualizer/tools/useToolInteraction.js` (constraint clip)
- `frontend/src/features/visualizer/VisualizerWorkspace.jsx` / `canvas/CanvasStage.jsx`
  (constraint wiring)
- `frontend/src/features/visualizer/panels/SidePanel.jsx` / `Inspector.jsx` (tabs + toggle)

### 7. Files to Create
- `backend/src/config/aiConfig.js` — flags/providers/counts/maxdim/product lines
- `backend/src/services/ai/aiResult.js`, `color.js` — envelope + LAB/HSL color math
- `backend/src/services/ai/aiRegistry.service.js` — capability dispatcher
- `backend/src/services/ai/providers/mockProvider.js`, `httpVisionProvider.js`
- `backend/src/services/ai/houseUnderstanding.service.js` — orchestration
- `backend/src/services/aiJobs.model.js` — `ai_jobs`/`detected_surfaces`/`detected_objects`
- `backend/src/controllers/ai.controller.js`, `backend/src/routes/ai.routes.js`,
  `backend/src/routes/meta.routes.js`
- `frontend/src/features/visualizer/hooks/useAiAnalysis.js` (analysis + surface constraint)
- `frontend/src/features/visualizer/panels/AIAnalyzeTab.jsx`
- `frontend/src/features/visualizer/hooks/useApplySurface.js` (shared with Feature B)

### 8. Database Changes
- New `ai_jobs` (versioned audit log: asset, job type, provider, model version, status,
  confidence, processing time, failure reason, output JSON) — FK to `assets`, cascade delete.
- New `detected_surfaces` (class key, display name, `paintable` flag, confidence, mask path,
  geometry/average-color/properties JSON) and `detected_objects` — both FK to `ai_jobs` +
  `assets`, cascade delete.
- `layers.ai_surface_key VARCHAR(80) NULL` — links a layer to the detected surface it came
  from (additive; added to `schema.sql` CREATE and `runSchema.js` upgrade columns for
  already-migrated DBs).
- All changes additive/idempotent — `npm run migrate` is safe to re-run.

### 9. API Changes
- `POST /api/assets/:assetId/ai/analyze` → runs the capability, persists the job + surfaces +
  objects, returns `{ ok, job, house, context, scale, surfaces[], objects[], meta }`.
- `GET /api/assets/:assetId/ai/analysis` → latest successful analysis
  (`{ analyzed, job, house, context, surfaces[], objects[] }`).
- `GET /api/meta` → `{ ai: { analysis: { enabled, provider, modelVersion },
  recommendation: { enabled, provider, modelVersion, count } } }` — feature-flag aware, the UI
  renders capability toggles from it.
- Errors: 404 unknown asset, 403 feature disabled, envelope `{ ok:false, failureReason, job }`
  for provider failures (never a bare 500).

### 10. UI Changes
- New side-panel section **AI Understand** (`AIAnalyzeTab`): "Understand this photo" CTA,
  provider/model/confidence/time meta, list of detected surfaces (paintable ones get an "Add
  layer" button; protected ones are tagged "Not paintable"), and a protected-objects list.
- New side-panel section **AI Schemes** (`RecommendationsTab`, see Feature B).
- **Surface lock** (Inspector, brush options): when the active layer came from AI analysis
  (`ai_surface_key` set), brush strokes are clipped to the detected surface mask
  (`aiSurfaceLock`, default on) so paint cannot escape the surface; the Inspector shows an
  "AI surface · <key>" badge.
- Apply flow reuses the standard layers API (`createdVia: 'ai-surface'`), so undo/redo/history
  treat AI layers exactly like hand-drawn ones.

### 11. Risks
- Heuristic masks (mock) are imperfect vs. a real segmentation model → mitigated by
  `confidence` per surface, the surface lock (brush stays inside the detected mask), and
  editability (AI layers are ordinary layers you can refine/erase).
- Non-paintable surfaces being painted → mitigated structurally: `paintable=false` surfaces
  have no "Add layer" affordance and are skipped by scheme application; the brush constraint
  further prevents leaking onto windows/trees.
- Analysis resolution (640) lower than the photo → masks are upscaled on apply; the renderer
  never sees analysis resolution.

### 12. Performance Impact
- Analysis is a one-off, synchronous, in-process run for `mock` (a few hundred ms on a 640px
  image) or a bounded outbound call for `http-vision` (`AI_VISION_TIMEOUT_MS`). No hot path is
  affected: rendering/compositing stays client-side and unchanged; masks are stored as files,
  never inline pixels.

### 13. Rollback Strategy
- Feature flag `AI_ANALYSIS_ENABLED=false` disables the capability server-side (403) without
  code changes; the UI hides/disables the panel from `/api/meta`.
- Reverting the branch: DB changes are additive; dropping the tables is safe because no
  existing table is altered except an additive nullable column.

### 14. Testing Strategy
- Backend smoke tests against a real MySQL: analyze → analysis → recommendations →
  `/api/meta`, plus 404/403 cases; verified mask PNG validity at analysis resolution and
  correct role→paintable mapping. Re-run via the public API on the dev DB.
- Frontend: `npm run build` (no lint script configured); manual flow — upload → analyze →
  add layer → paint → surface-lock brush.

### 15. Implementation Priority
High — it is the foundation for Feature B and the flagship differentiator of the platform.

### 16. Estimated Complexity
Medium. The mock provider is the bulk (heuristics); orchestration, persistence, and UI are
straightforward extensions of existing patterns.

### 17. Future Scalability
- Swap in a real segmentation vendor behind `http-vision` (same schema) for far better masks
  with zero UI/API changes.
- Move analysis to a job queue for async processing of large batches.
- Add per-surface "preview on canvas" overlays and paintability heatmaps.

---

## Feature B — AI Paint Recommendations

### 1. Objective
Generate 5–10 complete, dealer-presentable paint schemes for an analyzed asset. Each scheme is
a named, tagged color plan in which every role (primary wall, accent wall, trim, doors, roof,
gutter, …) is mapped to a specific detected surface and a specific paint from the catalog.

### 2. Business Value
The dealer goes from "which colors work together?" to a full, internally consistent plan in one
click — and because every color is a real catalog product, the plan is immediately actionable
for ordering. Scheme application produces real, editable layers.

### 3. Technical Design
- Requires a successful house-understanding first (409 if missing) — recommendations are
  grounded in actual detected surfaces, never invented.
- Runs server-side (`POST /api/assets/:assetId/ai/recommendations`); provider bound by
  `AI_RECOMMENDATION_PROVIDER` (default `catalog`).
- Every scheme references catalog paint IDs only; the API resolves them to full paint objects
  on read (`resolveScheme`), so the UI never re-joins catalog data and never invents a color.
- `AI_RECOMMENDATION_COUNT` (default 6, clamped 1–10) controls batch size;
  `AI_RECOMMENDATION_PRODUCT_LINES` optionally restricts the candidate pool (falls back to the
  whole catalog when the filtered pool is empty).
- Schemes persist in `paint_recommendations` (`scheme_json` holds role→surface→paint);
  regenerating replaces the asset's previous batch.

### 4. AI Design
- **catalog provider** (`providers/catalogRecommendationProvider.js`, `catalog-rules-v1`):
  rule-based color theory (complementary, analogous, neutral, monochrome, …) evaluated across
  8 named templates (classic-neutral, coastal, modern-monochrome, earthy-warm, bold-accent,
  soft-pastel, heritage, fresh-garden), scored against the catalog paints actually available.
  Each generated surface assignment is validated against the detected paintable surface set —
  a scheme physically cannot reference a non-paintable or non-detected surface.
- Provider-independent by the same registry; a future model-based recommender can replace the
  rule engine without touching the API/UI.

### 5. Integration Strategy
- Same sub-route mount as Feature A: `POST/GET /api/assets/:assetId/ai/recommendations`.
- Shares `useApplySurface` with the Analyze tab; applying a scheme creates one real layer per
  paintable surface through the standard layers API (paintable check server- and client-side).

### 6. Files to Modify
- Same set as Feature A (routes, app.js, schema, env, api.js, SidePanel, Inspector) — the two
  features share the wiring and the apply pipeline.

### 7. Files to Create
- `backend/src/services/ai/providers/catalogRecommendationProvider.js`
- `backend/src/services/ai/paintRecommendation.service.js`
- `backend/src/services/paintRecommendation.model.js`
- `frontend/src/features/visualizer/hooks/useRecommendations.js`
- `frontend/src/features/visualizer/panels/RecommendationsTab.jsx`

### 8. Database Changes
- New `paint_recommendations` (project, asset, scheme name, tagline, rationale JSON, scheme
  JSON, status `draft|applied`) — FK to `projects` + `assets`, cascade delete. Additive.

### 9. API Changes
- `POST /api/assets/:assetId/ai/recommendations` (`{ count? }`) → `{ schemes[], meta }` where
  each scheme's surfaces are `{ role, surfaceClass, paintId, paint }` (paint fully resolved).
- `GET /api/assets/:assetId/ai/recommendations` → persisted schemes (resolved).
- Errors: 404 unknown asset, 403 disabled, 409 not analyzed yet or empty catalog, 502 provider
  failure.

### 10. UI Changes
- **AI Schemes** panel: "Generate N schemes" button; each card shows scheme name, tagline, a
  swatch strip (one per role), the role→paint mapping, and an **Apply** button that creates
  the layers. "Catalog-only — every color is a real product" is shown on each card.

### 11. Risks
- Catalog gaps (a role needs a color the catalog lacks) → the rule engine scores and picks the
  closest available; the candidate pool can be constrained by product line.
- Non-paintable surfaces mapped to paint → structurally impossible: the provider validates
  against the detected paintable set and the apply flow double-checks client-side.

### 12. Performance Impact
- Generation is a pure in-process rule evaluation over the catalog (single-digit ms on the
  smoke test); the only I/O is one catalog read and the writes. No effect on rendering.

### 13. Rollback Strategy
- `AI_RECOMMENDATION_ENABLED=false` disables the capability (403 + UI hidden). Additive schema
  only; `paint_recommendations` can be dropped safely.

### 14. Testing Strategy
- Backend smoke: generate 6 schemes, assert every surface maps to a detected paintable class
  and every paint resolves to a catalog row (`hex_value` present). Verified on the dev DB.
- Frontend: `npm run build`; manual flow — analyze → generate → apply scheme → confirm layers
  appear in Layers/undo stack with correct `ai_surface_key`.

### 15. Implementation Priority
High — ships in the same feature branch as Feature A.

### 16. Estimated Complexity
Low–Medium. Rule-based generation is compact; the surrounding plumbing is shared with
Feature A.

### 17. Future Scalability
- Swap the `catalog` provider for a generative model behind the registry (same schema).
- Persist "applied" status + dealer feedback to feed later preference-aware ranking.
- Batch generation across a project's photos for multi-room proposals.
