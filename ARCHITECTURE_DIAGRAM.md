# ARCHITECTURE_DIAGRAM — AI House Understanding pipeline

```mermaid
flowchart LR
  subgraph FE["FRONTEND (React / Vite / Konva)"]
    UP[AssetsTab upload]
    AT[AIAnalyzeTab]
    RT[RecommendationsTab]
    CT[AssetsTab concepts]
    AM[useAssetAnalysis]
    AS[useApplySurface]
    AC[useApplyColor]
    CS[CanvasStage]
    LN[LayerNode]
    CE[colorEngine.applyPaintColor]
    WC[VisualizerWorkspace]
  end

  subgraph BE["BACKEND (Express / CommonJS)"]
    AIC[ai.controller]
    HUS[houseUnderstanding.service]
    REG[aiRegistry]
    MP[mockProvider]
    HVP[httpVisionProvider]
    SVC[storage.service]
    PRC[paintRecommendation.service]
    CRP[catalogRecommendationProvider]
    LC[layers.controller]
    LM[layers.model]
    CC[concepts.controller]
  end

  subgraph DB["MySQL paint_visualizer_pro"]
    P[paints]
    L[(layers)]
    H[(history_entries)]
    C[(concepts)]
    J[(ai_jobs)]
    S[(detected_surfaces)]
    O[(detected_objects)]
    R[(paint_recommendations)]
  end

  UP -->|POST /assets| AIC
  AT -->|POST /assets/:id/ai/analyze| AIC
  AIC --> HUS --> REG --> MP
  REG --> HVP
  MP -->|Jimp masks| SVC -->|PNG uploads/<asset>/ai/| FS[(disk)]
  HUS -->|insert| J
  HUS -->|insert| S
  HUS -->|insert| O

  AM -->|GET /analysis| AIC
  AM -->|mask_url| AT
  RT -->|POST /recommendations| PRC --> REG --> CRP -->|paints| P
  PRC -->|insert| R

  AT -->|"Add layer (surface)"| AS
  RT -->|"Apply scheme"| AS
  CT -->|"Apply concept"| AS
  AS -->|POST /layers (upsert ai-surface)| LC --> LM -->|upsert on ai_analysis_id+ai_surface_key| L
  AS -->|history| H
  AC -->|PATCH current_color_id| LM --> L

  L -->|GET /layers| CS
  CS --> LN
  LN -->|baseImageData + maskData + color| CE
  CE -->|composite| RENDER[(Canvas / export)]
  WC -->|surface-pick tool| LN
  WC -->|mask refine strokes| L

  RT -->|"Save as concept"| CC -->|POST /concepts| C
```

## Legend
- **Renderer** = `colorEngine.applyPaintColor` + `LayerNode` — the only thing that paints the image.
- **AI pipeline** = providers produce structured understanding (masks/surfaces/objects/schemes) — never paints.
- **Idempotency** = Phase-1 unique index `(ai_analysis_id, ai_surface_key)` + server-side upsert.
- **Concept gallery** = Phase-2 preview composer (reuses `CE`) + existing `concepts` API.
- **Semantic painting** = Phase-3 `surface-pick` tool hit-tests analysis masks.

## Data model (core tables, changes in bold)
```
assets(id, project_id, file_path, status, created_at)
layers(id, asset_id, project_id, name, mask_path, current_color_id FK->paints,
       created_via ENUM('manual','ai-surface'), order_index,
       ai_surface_key, **ai_analysis_id INT NULL**, **ai_scheme_id INT NULL**,
       UNIQUE(ai_analysis_id, ai_surface_key), created_at, updated_at, deleted_at)
detected_surfaces(id, analysis_id FK->ai_jobs.id, asset_id, class_key, display_name,
       paintable, mask_path, confidence, geometry, average_color, role)
ai_jobs(id, asset_id, job_type, provider, status, confidence,
       processing_time_ms, model_version, output_json, failure_reason)
paint_recommendations(id, analysis_id, paint_id, role, scheme_json)
concepts(id, project_id, name, thumbnail, layer_color_map, created_at)
history_entries(id, project_id, description, payload, created_at)
```

## Flow when a scheme is applied (post-Phase-1/2)
1. `RecommendationsTab` renders preview cards via `renderSchemePreview` (base image + masks + `applyPaintColor`).
2. Dealer clicks **Apply** → `useApplySurface.applyScheme` → for each paintable surface `POST /api/layers` with `createdVia='ai-surface'`, `aiAnalysisId`, `aiSchemeId`, `aiSurfaceKey`, mask blob.
3. Server `upsertAiLayer`: new row (201) or in-place color/order update (200) — never duplicates.
4. react-query invalidates `['layers', assetId]` → `CanvasStage` rebuilds `LayerNode`s → `colorEngine` repaints.
5. **Save as concept** → `POST /api/projects/:id/concepts` (thumbnail + `layerColorMap`). Later, **Apply concept** → same step 2 path → editable layers.

## Error handling
- 404 unknown asset; 403 AI disabled; 409 no analysis / empty catalog; 422 invalid scheme; 500 provider failure (job marked failed with `failure_reason`).
