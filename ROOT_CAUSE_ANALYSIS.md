# ROOT_CAUSE_ANALYSIS — AI Understanding Pipeline

Branch audited: `feat/ai-house-understanding` (base `dev`)
Audit date: 2026-08-04
Scope: Upload → AI House Understanding → Surface Detection → Masks → Catalog Recommendation → Layer Creation → Renderer → Concept Generation → Manual Editing → Export

Every claim below is verified against the code in the repository and the live MySQL dev database (`paint_visualizer_pro`). File references are `path:line`.

---

## 1. Current Architecture (as built)

```
                ┌─────────────────────────── FRONTEND (React/Vite/Konva) ───────────────────────────┐
                │                                                                                    │
                │  SidePanel tabs: Assets · Layers · History · AI · AI Understand · AI Schemes · …   │
                │     ├─ AIAnalyzeTab.jsx          ── analyze, list surfaces, "Add layer"            │
                │     ├─ RecommendationsTab.jsx    ── generate schemes, swatch strips, "Apply"       │
                │     └─ AISuggestionsTab.jsx      ── per-layer colorSuggest (pre-existing feature)  │
                │                                                                                    │
                │  useApplySurface.js  ── surface/scheme -> layers.create(mask PNG, aiSurfaceKey)     │
                │  CanvasStage.jsx ── Konva stage; per-layer LayerNode.jsx composites via             │
                │     colorEngine.applyPaintColor()  (the RENDERER — client-side LAB blend)          │
                └──────────────────────────┬─────────────────────────────────────────────────────────┘
                                           │ REST (fetch)
                ┌──────────────────────────▼─────────────────────────── BACKEND (Express/CommonJS) ─┐
                │  /api/assets/:id/ai/analyze  ── ai.controller ── houseUnderstanding.service ──    │
                │     aiRegistry ── provider ('mock' | 'http-vision') ── jimp heuristics            │
                │  /api/assets/:id/ai/recommendations ── paintRecommendation.service ──              │
                │     'catalog' provider (color-theory rules over paints table)                     │
                │  layers.controller ── layers.model (mysql2 pool) ── storage.service (PNG on disk) │
                └──────────────────────────┬─────────────────────────────────────────────────────────┘
                                           │
                                MySQL: paints, projects, assets, layers,
                                history_entries, concepts, export_jobs,
                                ai_jobs, detected_surfaces, detected_objects, paint_recommendations
```

---

## 2. Execution flow — verified step by step

### 2.1 Frontend flow
1. **Upload**: `AssetsTab.jsx:68` → `assets.upload` → `POST /api/projects/:id/assets`.
2. **Analyze**: `AIAnalyzeTab.jsx:34` `runAnalysis()` → `ai.analyze(assetId)` → `POST /api/assets/:id/ai/analyze`.
3. **Read analysis**: `useAssetAnalysis` (`useAiAnalysis.js:14`) → `GET /api/assets/:id/ai/analysis`; surfaces carry `mask_path`, `paintable`, `class_key`, `analysis_id`.
4. **Apply surface**: `AIAnalyzeTab.jsx:43` `addSurface()` → `useApplySurface.applySurface()` (`useApplySurface.js:21`) → `layers.create(…, maskBlob)` where the mask is the analysis mask upscaled to canvas resolution (`surfaceMaskToPngBlob`, `useApplySurface.js:71`).
5. **Apply scheme**: `RecommendationsTab.jsx:52` → `applyScheme()` (`useApplySurface.js:42`) → one `layers.create` per paintable surface with the scheme's catalog paint.
6. **Render**: react-query invalidation re-fetches layers (`useLayers.js:16`); `CanvasStage.jsx:198` maps each layer to `LayerNode.jsx`; `LayerNode.jsx:43` calls `applyPaintColor(baseImageData, maskData, colorRgb, …)` — **the renderer**. Color changes update via `colorRgb` effect deps (`LayerNode.jsx:56`).
7. **Paint**: brush → `useToolInteraction.js` → `surfaceAwareBrushStroke`/`rasterizeBrushStroke` → `onCommitMask` → `handleCommitMask` (`VisualizerWorkspace.jsx:184`) → new layer or `commitMaskEdit` PATCH.

### 2.2 Backend flow
- `ai.controller.js:13` → `houseUnderstanding.service.js:18 analyzeAsset()`:
  - asset lookup (404) → capability flag (403) → `createJob` (`aiJobs.model.js:14`) → `aiRegistry.run('house-understanding')` (`aiRegistry.service.js:50`) → provider.
  - On success: for each surface `saveMask()` (`houseUnderstanding.service.js:116`, Jimp→alpha PNG→`storage.saveBuffer`) + `createSurface`; same for objects; `markSuccess`.
- `paintRecommendation.service.js:15 generateRecommendations()`: asset → flag → latest analysis (409 if none) → `paintsModel.list` (409 if empty) → `aiRegistry.run('paint-recommendation')` → `catalogRecommendationProvider.run` → persist via `paintRecommendation.model.js` (clears previous batch first) → `resolveScheme` attaches full paint objects.
- `layers.controller.js:8 createLayer`: validates `createdVia` (`ai-surface` allowed), saves mask PNG, inserts layer row.

### 2.3 Database flow
- `ai_jobs` (audit log), `detected_surfaces`, `detected_objects` (metadata + `mask_path`), `paint_recommendations` (scheme JSON), `layers` (mask_path + `current_color_id` FK→paints + `ai_surface_key`).
- Schema: `backend/src/sql/schema.sql:169-238`; idempotent upgrade: `scripts/runSchema.js:25`.

### 2.4 API flow (all live on dev DB)
- `POST /api/assets/:id/ai/analyze` → 200 `{ok, job, house, context, surfaces[], objects[], meta}` (mock provider, ~550 ms).
- `GET /api/assets/:id/ai/analysis` → 200 `{analyzed:true, job, house, context, surfaces, objects}`.
- `POST/GET /api/assets/:id/ai/recommendations` → 200 `{schemes[], meta}` / scheme list.
- `GET /api/meta` → 200 flags/providers.

### 2.5 State management flow
- Server state: TanStack Query (`['layers', assetId]`, `['ai-analysis', assetId]`, `['ai-recommendations', assetId]`, `['concepts', projectId]`).
- Ephemeral editor state: Zustand (`visualizerStore.js`) — tool, brush, viewport, undo stack, `aiSurfaceLock`, `pendingColorId`.

### 2.6 Rendering flow (verified working)
- Layer → `LayerNode.jsx` → mask PNG loaded via `useImageElement` → `applyPaintColor(baseImageData, maskData, targetRgb, 0.95, {lightnessBlend:0.45})` (`colorEngine.js:118`) → new `<canvas>` → `KonvaImage`. **The renderer IS called and DOES repaint when `current_color_id` changes** (react-query optimistic patch `useLayers.js:27` + effect deps).

**Where the pipeline currently stops / gaps** — see §4.

---

## 3. Verification of each audit question

| Question | Verdict | Evidence |
|---|---|---|
| Is AI Understanding real AI, rule-based, mock, placeholder, or hardcoded? | **Rule-based heuristic ("Developer Mock")** — a genuine image-ops pipeline, NOT a learned model, NOT hardcoded JSON. | `mockProvider.js:5-18` "stand-in, not a model"; full per-pixel LAB/HSL segmentation, bbox, connected components (`mockProvider.js:55-433`). Provider-swappable via `aiRegistry` + `httpVisionProvider.js`. |
| How are masks generated? | Server-side in the provider at analysis resolution (≤640 long edge), via Jimp. | `mockProvider.js:55-61`, `houseUnderstanding.service.js:116-123`. |
| Which algorithm/model? | BFS connected components, row/column projection bbox, LAB-distance roof split, dilation for trim, region grow for obstacles. | `mockProvider.js:509-564`. |
| How are masks stored? | Alpha PNG on disk under `uploads/<assetId>/ai/<key>.png`; row reference in `detected_surfaces.mask_path`. | `houseUnderstanding.service.js:53,116-122`. |
| How are masks rendered? | Only after promotion to a layer: upscaled to canvas res client-side, composited by `LayerNode`/`colorEngine`. | `useApplySurface.js:71`, `LayerNode.jsx:33-46`. |
| How are masks loaded? | `assets.fileUrl(mask_path)` + `crossOrigin` Image → canvas → ImageData/grid. | `useAiAnalysis.js:59`, `VisualizerWorkspace.jsx:449`. |
| How are masks refined? | Brush mask-edit add/subtract (`VisualizerWorkspace.jsx:201-211`), eraser (`:188-196`), surface-aware smart brush (`maskOps.js:173`), AI-surface-lock clipping (`maskOps.js:14`). | |
| Front Wall / Right Wall / Trim / Roof / Gutter / Windows / Doors detected? | **Detected heuristically — real, computed masks, but approximated.** | `front-wall` `mockProvider.js:272`, roof `:226,271`, trim `:258-273`, gutter `:277-288`, left/right-wall = 10% side bands `:290-311`, door `:249,274`, windows `:255,275`. |
| Railings / Columns detected? | **NOT detected** — no code path. | grep: no 'railing'/'column' in providers. |
| How are colors selected? | **From the catalog only.** Rule targets (HSL) scored by LAB distance against `paints` rows; never hardcoded paint IDs. | `catalogRecommendationProvider.js:146-221`; `pick()` `:211`. |
| Where is `current_color_id` assigned? | Client `layers.create`/PATCH; set from scheme paint on apply, or user picks via `useApplyColor.js:19`. DB FK enforces existence. | `useApplySurface.js:29,53`; `useApplyColor.js:23-28`. |
| Is the renderer ever called? | **Yes** — the only paint path. | `LayerNode.jsx:43`. |
| If layer colors change, why doesn't the image update? | **It does update.** (Optimistic patch + LayerNode effect on `colorRgb`.) Any stale-display report is the known mask-cache invalidation path, already handled in `VisualizerWorkspace.jsx:112-156`. | `useLayers.js:27`, `LayerNode.jsx:56`. |
| Is 5–10 scheme → rendered preview → gallery → select → editable happening? | **NO.** Schemes generate (swatch strips only); **no rendered previews, no concept gallery, no select-to-apply-with-layers beyond manual Apply.** | `RecommendationsTab.jsx:88-124` renders color bars, not images. |
| Why duplicate AI layers continuously inserted? | **No idempotency.** `useApplySurface` always calls `layers.create`; nothing keys layers to an analysis job; unique index absent. Live DB shows the same scheme applied twice as rows 356–366. | `useApplySurface.js:24,48`; DB query (asset `578a49c5…`). |
| Why does workspace still behave like an image editor? | **No click-a-surface interaction exists.** Tools are pixel-space (rect/lasso/polygon/wand/brush); clicking never resolves to a detected surface. | `toolDefs.js:4-28`, `useToolInteraction.js:88-123`. |

---

## 4. Actual vs. Expected — gaps

| # | Expected | Actual | Status |
|---|---|---|---|
| G1 | AI Understanding | ✓ rule-based provider; real structured output | **Works** |
| G2 | Surface detection → masks | ✓ heuristics, saved to disk+DB | **Works** (approximate; no railings/columns) |
| G3 | Catalog recommendation | ✓ catalog-only, LAB-scored | **Works** |
| G4 | Layer creation | ✗ duplicate rows; not keyed to analysis | **Broken (duplication)** |
| G5 | Renderer paints | ✓ LayerNode + colorEngine | **Works** |
| G6 | Canvas refresh on apply | ✓ react-query + LayerNode | **Works** |
| G7 | Concept generation (5–10 rendered previews) | ✗ none | **Missing** |
| G8 | Concept gallery → select → editable layers | ✗ none | **Missing** |
| G9 | Concept stored in DB | Table + API exist; no UI calls `concepts.create` | **Missing (UI)** |
| G10 | Semantic painting: click wall → whole wall → paint | ✗ click does nothing; pixel tools only | **Missing** |
| G11 | Brush = mask refinement (Add/Remove/Edge/Polygon/Smart) | Partial: add/subtract via Alt, eraser, surface-aware, aiSurfaceLock, polygon tool | **Partial** |
| G12 | Export | ✓ existing panels | **Works** |

---

## 5. Classification

### 5.1 Missing components
- AI layer ↔ analysis-job binding (`layers.ai_analysis_id`).
- Idempotent AI layer upsert (server + client).
- Rendered scheme preview composer (reuses `colorEngine` — must not create a second engine).
- Concept gallery UI + "Save as concept" (thumbnail + `layerColorMap`).
- Semantic surface pick tool (hit-test analysis masks at pointer → whole-surface paint).
- Explicit mask-refine modes (Add/Remove buttons) and surface-tool options.

### 5.2 Broken components
- AI layer dedup (root cause of "infinite duplicate inserts"). Evidence: live DB rows 356–366 duplicated scheme surfaces; `useApplySurface.js` creates unconditionally.

### 5.3 Placeholder / stub components
- `mockProvider.js` is an explicitly-labeled stand-in for a real segmentation model (`mockProvider.js:16`). Functioning heuristic, but not a learned CV model. `httpVisionProvider.js` is the real-model path (requires `AI_VISION_URL`).

### 5.4 Unused / dead code
- `concepts.create` API + `concepts` table: **no frontend caller** (only `conceptsApi.list` in `AssetsTab.jsx:52`). `AssetsTab.jsx:189` says "Save a Concept from the canvas toolbar" — **no such toolbar control exists**.
- `layers.createdVia='ai-surface'` rows get `commitCreate` history every apply → duplicates also spam history.

### 5.5 Duplicate logic
- `loadAlphaGrid` (`useAiAnalysis.js:59`) duplicates `loadMaskImageData` (`VisualizerWorkspace.jsx:449`) and `surfaceMaskToPngBlob` (`useApplySurface.js:71`) — three copies of the load-image→canvas→pixels path. Consolidate into one shared helper.

### 5.6 Integration failures
- Apply flows create layers without recording which analysis produced the surface → ambiguous surface identity across re-analyses; no idempotency.
- Scheme application has no rendered feedback (no preview) → dealer can't "see" a scheme before committing.

### 5.7 Database issues
- `layers` lacks `ai_analysis_id` and a uniqueness guarantee for AI surface layers.
- No concept created by any code path.

### 5.8 Rendering issues
- None in the renderer itself. (Previews must reuse `LayerNode`'s exact `applyPaintColor` parameters to look identical.)

### 5.9 Frontend issues
- No surface-tool hit-testing; brush refinement modes only via Alt modifier; concept gallery absent; duplicated image-load helpers.

### 5.10 Backend issues
- `layers.controller`/`layers.model` have no ai-surface upsert; `aiAnalysisId` not plumbed.

### 5.11 AI issues
- Provider is heuristic (known, documented); railings/columns unsupported; object detection limited (no cars/people classification).

---

## 6. Priority

| Priority | Item |
|---|---|
| **Critical** | G4 — AI layer dedup/idempotency (schema + model + controller + client) |
| **Critical** | G7/G8/G9 — Concept generation: rendered preview gallery, select → editable layers, persist concept |
| **High** | G10 — Semantic surface pick & paint (click wall → whole wall → renderer paints) |
| **High** | G11 — Explicit mask refinement modes (Add/Remove/Edge refine affordances) |
| Medium | 5.5 — consolidate duplicated image-load helpers |
| Medium | G2 — (documented) heuristic segmentation limits |
| Low | 5.4 — remove stale AssetsTab copy that references a nonexistent toolbar control |

No implementation was performed before this report was written.
