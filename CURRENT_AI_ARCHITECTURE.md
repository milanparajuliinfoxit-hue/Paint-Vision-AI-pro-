# CURRENT AI ARCHITECTURE — Phase 0 Discovery

Read-only audit of the Paint Visualizer repo as it exists on branch
`implementation/ai-house-understanding`, produced ahead of the Gemini
visualization-workflow pivot. Every claim below is sourced from the actual
current code (paths cited), not from the repo's own prior audit docs
(`AI_HOSTED_ARCHITECTURE.md`, `IMPLEMENTATION_BASELINE.md`, etc.), which were
cross-checked but are treated as secondary evidence, not ground truth.

No application code was modified to produce this document.

---

## 1. Existing AI Providers

Two independent provider registries exist today — they are not unified, and
that distinction matters for where new Gemini code should plug in.

### 1a. `aiRegistry.service.js` registry (`backend/src/services/ai/aiRegistry.service.js`)

Capability-based dispatcher. `PROVIDERS` array (line 44) holds:

| id | capability | file | what it does |
|---|---|---|---|
| `catalog` | `paint-recommendation` | `providers/catalogRecommendationProvider.js` | Rule-based color-theory scoring against catalog paints only. Zero cost, zero external dependency, never invents a color — every scheme surface maps to a real `paints.id`. |
| `hf-scheme` | `paint-recommendation` | `providers/hfSchemeProvider.js` | Hosted Llama model (`AI_SCHEME_MODEL`, default `meta-llama/Llama-3.1-8B-Instruct` via HF's `novita` inference provider) used for scheme *naming/rationale*, still constrained to catalog paint IDs — the LLM never picks arbitrary RGB. |
| `replicate-vision` | `house-understanding` | `providers/replicateVisionProvider.js` | Grounding DINO (detection) + SAM2 (segmentation) on Replicate, two-stage pipeline. Per its own header comment, blocked on this Replicate account's billing (HTTP 402) as of the last time it was tested live. |
| `fal-vision` | `house-understanding` | `providers/falVisionProvider.js` | SAM 3 on fal.ai (`fal-ai/sam-3/image`), single model/single call per surface class — real open-vocabulary text-to-mask segmentation, current default (`AI_ANALYSIS_PROVIDER=fal-vision` in `.env.example`). One schema assumption is explicitly flagged unverified in the file's own header: whether `image_url` accepts a `data:` URI directly vs. requiring a separate fal upload step — "flagged for the first live call to confirm" (line 24). **This means fal-vision's real end-to-end output has not been confirmed against a real API call as of this audit.** |

`mockProvider.js` exists but is deliberately **not** in `PROVIDERS` — the
registry's own header (lines 32-35) states it is kept only as an
unreachable-from-production fixture; `getProviderFor` fails loudly for any
unregistered/unsupported provider id rather than silently falling back to it.

Only one provider is active per capability at a time, selected by
`AI_ANALYSIS_PROVIDER` / `AI_RECOMMENDATION_PROVIDER` env vars
(`backend/src/config/aiConfig.js` lines 36-39). `AI_ANALYSIS_ENABLED=false`
is the current documented default in `.env.example` — **house-understanding
is off unless a dealer/operator has both flipped the flag and supplied a
real API key** (`houseUnderstanding.service.js` line 37-41 enforces this at
call time, not just in config).

### 1b. `aiProxy.service.js` registry (`backend/src/services/aiProxy.service.js`)

Separate, much simpler `switch` dispatcher for the **object-removal/cleanup**
capability only — not part of `aiRegistry`'s `PROVIDERS` array at all:

| provider (`AI_PROVIDER` env var) | file | what it does |
|---|---|---|
| `clipdrop` (default) | `providers/clipdrop.js` | ClipDrop's hosted Cleanup API — multipart image + optional mask → inpainted image buffer. Guards against an unfilled `CLIPDROP_API_KEY` placeholder (line 21). |
| `huggingface` | `providers/huggingface.js` | HF-hosted inpainting model, alternate cleanup path. |

Public contract: `callCleanup(imageBuffer, maskBuffer) → Promise<Buffer>`
(`aiProxy.service.js` line 12). Invoked from
`assets.controller.js:requestCleanup` (line 66), which builds a removal mask
either from the dealer's own brush strokes or, absent one, from
`objectRemovalMask.service.js`'s auto-mask built off already-detected
tree/car/person/fence objects (`assets.controller.js` lines 74-85), then
validates the result didn't damage the house itself via
`removalQuality.service.js` before ever writing `cleaned.jpg` to disk (lines
89-99).

### KEEP / REFACTOR / DEPRECATE / REMOVE

| Provider | Classification | Justification |
|---|---|---|
| `catalog` (paint-recommendation) | **KEEP** | Zero-cost, zero-dependency, catalog-only by construction — directly reusable as-is for the new spec's Section 12/26 "catalog is the only source of truth for colors" requirement. No relationship to Gemini. |
| `hf-scheme` (paint-recommendation) | **KEEP** | Optional LLM-assisted naming/rationale on top of catalog-constrained colors; orthogonal to the visualization pivot, no conflict with adding Gemini as an *image* provider. |
| `fal-vision` (house-understanding) | **KEEP, but flag as unvalidated** | The new spec's Section 8/23/35 explicitly requires *validated* real pixel masks before trusting them for manual refinement — this provider's core request shape has one unconfirmed assumption per its own header. Keep it registered (it's the only house-understanding path not blocked on billing) but do not assume it "just works" for Phase 4/Mask Experiment; run the live-call validation the code itself already calls out before building UI around it. |
| `replicate-vision` (house-understanding) | **DEPRECATE (per spec Section 28)** | Not removed — the new spec explicitly says "must NOT remain a hard dependency" for the new primary path, but "keep the provider abstraction capable of supporting segmentation later" and don't "spend further implementation effort trying to make Replicate billing work." It is already not the default provider (`fal-vision` is). No code deletion needed — just don't invest further here, and don't let anything new depend on it being available. |
| `clipdrop` / `huggingface` (cleanup) | **KEEP** | Entirely orthogonal capability (object removal before painting, not coloring) — Section 42 "do not break existing functionality" applies directly; nothing in the new spec touches this. |
| `mockProvider.js` | **KEEP as-is** | Already unreachable from production by the registry's own design; a legitimate test fixture, not a live code path to worry about. |

**No local/on-device AI model exists anywhere in the current codebase** — every
provider above is a hosted HTTP API call (fal.ai, Replicate, Hugging Face
Inference, ClipDrop). This satisfies the new spec's Section 29 "no local AI"
constraint with zero migration work; there is nothing to remove.

---

## 2. Existing Image Pipeline

Per-asset file layout on disk (`storage.service.js`-managed, under
`backend/uploads/<assetId>/`):

```
<assetId>/
    original.jpg           (assets.original_path)
    cleaned.jpg             (assets.cleaned_path, optional — post object-removal)
    ai/
        <surface-class>.png (per-surface alpha masks, house-understanding)
        <object-class>.png  (per-object alpha masks, removable obstructions)
uploads/<assetId>/
    <layer-id-or-uuid>.png  (per-layer paint masks — a *second*, disjoint
                             directory tree; multiple comments in the repo,
                             e.g. assets.controller.js:150-152, flag this as
                             a historical inconsistency, not a design choice)
```

Upload flow: `assets.controller.js:uploadAsset` validates real image bytes
(`isRealImage`) and rejects oversized dimensions *before* decoding
(decompression-bomb guard), creates the DB row first for the UUID folder
name, then writes `original.jpg`.

Cleanup flow: `assets.controller.js:requestCleanup` → `aiProxy.callCleanup`
→ `removalQuality.checkHouseDamage` gate → `cleaned.jpg`. The original is
never overwritten; this is already the "never overwrite original" pattern
the new spec's Section 17 requires.

---

## 3. Existing Catalog System

`paints` table (`schema.sql` lines 10-36): flat table, no brand/collection
free-text field — instead seven boolean product-line flags (`tenprotect`,
`brightshine`, `colorfuleco`, `jotashield`, `majestic`, `sevenprotect`,
`surprised`) act as the closest equivalent to "collection," filterable via
`?productLine=` on `GET /api/catalog` (`paints.controller.js:listPaints`).
`hex_value` is a MySQL *generated* column computed from `r_value`/`g_value`/
`b_value` — never stored independently, so hex and RGB can never drift.

**Two gaps relative to the new spec's Section 4 example catalog-color JSON:**
- **No `finish` column on `paints`.** Finish today lives on `layers.finish_override`
  (a per-layer override, not a catalog attribute) — `schema.sql` line 118.
  The new spec's example payload assumes `finish` is part of the catalog
  color record; it currently isn't anywhere in the DB.
- **No stored LAB values.** `rgbToLab` (`frontend/src/shared/lib/colorEngine.js`)
  computes LAB client-side, on demand, from `r_value`/`g_value`/`b_value` —
  there is no `lab_l`/`lab_a`/`lab_b` column. Fine for the existing
  client-side recolor engine; the new spec's Section 4 wants LAB handed to
  Gemini in the prompt, which would need computing server-side (trivial —
  the same LAB math the frontend already has could be ported) or just
  omitted from the prompt as "optional" (the spec itself marks it optional).

CRUD API: `paints.routes.js` — full REST (`GET /`, `GET /:id`, `POST /`,
`PUT /:id`, `DELETE /:id` soft-delete via `is_deleted`). Reusable as-is; the
new spec's Section 12 "reuse existing catalog infrastructure, don't create a
second color database" requirement is already satisfiable with zero new
tables — `paints.id` is exactly the `catalogColorId` the new spec wants.

---

## 4. Existing Layers System

`layers` table (`schema.sql` lines 110-135): one row per paintable region.
Key fields: `mask_path` (alpha PNG on disk, never inline pixel data),
`created_via` enum (`brush|magic-wand|lasso|rect|polygon|ai-surface`),
`current_color_id` (FK → `paints.id`), `ai_surface_key` +
`ai_analysis_id` (links a layer back to the `detected_surfaces` row that
produced it — `(ai_analysis_id, ai_surface_key)` is a UNIQUE key, line 134,
so re-applying the same AI surface/scheme *updates* the existing layer
in-place instead of duplicating it — real idempotency, not a convention).
Soft-delete via `deleted_at` so undo can restore a layer instead of
recreating a new id.

This is directly reusable as the new spec's "precision refinement layer"
(Section 22-23) — **the surface→catalog-color→layer pipeline the new spec
asks for in Sections 4/13 already exists end-to-end** today via
`useApplySurface.js` (`applySurface`/`applyScheme`,
`frontend/src/features/visualizer/hooks/useApplySurface.js`): a detected
surface's mask is upscaled to canvas resolution, a layer is created via the
standard layers API with `createdVia: 'ai-surface'`, and the deterministic
LAB recolor engine (`colorEngine.js`) paints it. No AI image generation is
involved anywhere in this existing path — it's 100% client-side pixel math.

---

## 5. Existing Masks

Every mask in the system (AI-detected surface/object, hand-drawn brush/
lasso/polygon/rect, AI wall-detection click-segment) is stored the same way:
an alpha-channel PNG on disk, loaded client-side into an `ImageData`/
`Uint8Array` alpha grid. `maskGeometry.js` and `maskOps.js` hold the shared
geometry/rasterization helpers (feathering, flood fill, polygon fill, brush
stroke rasterization, mask merge/subtract). AI-detected masks specifically
are confirmed **real per-pixel alpha data, not bounding boxes** — verified
directly against a stored asset's mask file during this audit
(`backend/uploads/578a49c5-.../ai/front-wall.png`, decoded: alpha values are
cleanly binary, 0 or 255, no bounding-box artifacts, 500×640 matching the
source photo's own resolution). This satisfies the new spec's Section 8 "do
not call a bounding box a pixel mask" concern for the *existing*
segmentation providers — but says nothing about what Gemini's own output
will contain, which is exactly why the new spec's Section 34/35 experiments
exist and must still be run.

---

## 6. Existing History

`history_entries` table (`schema.sql` lines 148-157): append-only undo/redo
log, persisted per-project (not per-asset), `before_state`/`after_state`
JSON snapshots, `superseded_at` marks an abandoned redo branch without ever
deleting a row (full audit trail preserved). `projects.undo_pointer`
persists where the client's local undo stack is positioned across reloads.
Frontend: `useHistoryCommand.js`, `HistoryTab.jsx`. This is generic
layer-mutation history — a new Gemini visualization job is not itself a
layer mutation, so it would need its own job-status model (Section 19 of
the new spec) rather than reusing `history_entries` directly, though a
*result* of accepting a Gemini visualization as new layers could commit
through the existing history path exactly like an AI-surface apply does
today.

---

## 7. Existing Cleanup (Object Removal)

Covered in §1b/§2 above. Summary: `POST /api/assets/:assetId/clean` (rate-
limited separately and more tightly than other endpoints —
`app.js` lines 40-44, 20/15min — because it's a billed external call),
`assets.controller.js:requestCleanup`, `aiProxy.service.js` dispatch to
ClipDrop or HF. Independent of house-understanding/recommendation/
visualization; nothing in the new spec touches it.

---

## 8. Existing Scheme Generation

`paintRecommendation.service.js`: `generateRecommendations(assetId, {count})`
→ requires a prior successful house-understanding analysis (line 44-49,
throws 409 otherwise) → filters out surfaces that failed
`surfaceQuality.service.js`'s quality gate (`tier !== 'low'`, line 74) →
calls the configured `paint-recommendation` provider with only
`{className, role, paintable}` per eligible surface (never raw pixels) plus
the *entire* catalog → provider returns `{schemes: [{name, tagline, surfaces:
[{surfaceClass, paintId}]}]}` → persisted to `paint_recommendations` table,
old schemes for the asset cleared first (`recommendationsModel.clearForAsset`,
line 98) — so it's always "latest full batch," not accumulating stale rows.
`resolveScheme` (line 138) joins each `paintId` back to the full catalog
paint object so the frontend never needs a second lookup.

This is the exact "Scheme A/B/C, each referencing real catalog colors"
structure the new spec's Section 25 asks for — **already implemented**, just
not yet connected to an AI-image-generation preview per scheme (today's
scheme preview is `renderSchemePreview.js`'s client-side LAB recolor of a
downscaled thumbnail, not a Gemini call).

---

## 9. Current Frontend Workflow

```
Upload photo (AssetsTab)
   → autonomous pipeline fires automatically post-upload
     (useAiPipeline.js → POST /ai/process, polled via GET /ai/status)
   → house-understanding analysis (if enabled+configured) populates
     "AI Understand" sub-tab (SurfacesTab.jsx → AIAnalyzeTab.jsx)
   → paint-recommendation runs automatically once analysis succeeds
     → RecommendationsTab.jsx shows scored schemes with rendered thumbnails
   → dealer either:
       a) applies a whole scheme (useApplySurface.applyScheme) — one layer
          per paintable surface, each pre-colored per the scheme, OR
       b) applies one detected surface at a time (applySurface) with a
          catalog color of their choosing, OR
       c) paints entirely manually: brush/lasso/polygon/rect/magic-wand/
          AI-click-to-segment-wall (useToolInteraction.js, useWallDetection.js)
   → every layer, however created, renders through the same deterministic
     LAB recolor pass (colorEngine.js:applyPaintColor) in LayerNode.jsx
   → ExportPanel.jsx composites all visible layers for download
```

There is currently **no AI image-generation step anywhere in this flow** —
"AI" in the current app means (a) segmentation/detection (fal-vision/
replicate-vision) and (b) catalog-constrained scheme *selection* (catalog/
hf-scheme), never pixel synthesis. The entire visual output the dealer sees
is the deterministic client-side LAB blend. This is the single biggest
structural gap the new spec's Gemini pivot fills — everything upstream
(surface detection UI, catalog color picker, scheme batches, layer/mask/
history persistence) is reusable scaffolding already built for exactly the
"dealer picks surface + catalog color" interaction model the new spec wants;
what's missing is only the image-synthesis provider and its job/prompt
plumbing (new spec Sections 6, 14, 19, 36).

---

## 10. Current API Contracts

```
POST   /api/projects/:projectId/assets              upload photo
GET    /api/assets/:assetId
PATCH  /api/assets/:assetId                          rename
DELETE /api/assets/:assetId
POST   /api/assets/:assetId/duplicate
POST   /api/assets/:assetId/clean                     object-removal (ClipDrop/HF)

POST   /api/assets/:assetId/ai/analyze                house-understanding (sync)
GET    /api/assets/:assetId/ai/analysis
POST   /api/assets/:assetId/ai/recommendations        scheme generation (sync)
GET    /api/assets/:assetId/ai/recommendations
POST   /api/assets/:assetId/ai/process                 autonomous pipeline (analyze+recommend)
GET    /api/assets/:assetId/ai/status                  pipeline poll
POST   /api/assets/:assetId/ai/segment-wall            click-to-segment (registered twice —
                                                          via ai.routes.js AND a direct
                                                          app.js fallback route, line 70-72,
                                                          "in case sub-router registration
                                                          fails" per its own comment)
GET    /api/meta                                        capability/provider feature-flag introspection

PATCH  /api/layers/:id           (mask upload via multipart, or JSON color/opacity/order patch)
DELETE /api/layers/:id
POST   /api/layers/:id/restore

/api/projects/:id, /:id/undo-pointer, /:id/assets, /:id/history, /:id/concepts, /:id/exports
/api/catalog  (paints CRUD)
/api/catalog/import (bulk import)
/files/*  (access-key-gated static file serving for photos/masks/exports)
```

`house-understanding` and `paint-recommendation` are **synchronous** HTTP
calls today (the controller awaits the full provider round-trip before
responding) — not the async job-queue model (queued→processing→complete)
the new spec's Section 19 wants for Gemini generation. `ai/process` +
`ai/status` is the closest existing precedent for a polled-status pattern,
but it polls a `run-to-completion` orchestrator, not a true background job
queue with cancellable/resumable state — worth noting as a real gap, not
just a naming difference, before Phase 3 designs the Gemini job lifecycle.

---

## 11. Database Dependencies / Reusable vs. New Schema

Reusable without any migration:
- `assets`, `paints`, `layers`, `history_entries`, `projects` — no changes
  needed for a Gemini path to slot in as another `layers` producer or a
  peer to `ai_jobs`.
- `ai_jobs` (`schema.sql` lines 195-219) — **already the general-purpose
  versioned-AI-run audit log** the new spec's Section 18/40 wants
  (provider, model_version, status, confidence, processing_time_ms,
  failure_reason, output_json, with a real DB-level constraint against
  concurrent duplicate runs via the `running_claim` generated column). A new
  `job_type` enum value (e.g. `'house-visualization'`) would very likely be
  sufficient here rather than a wholly new `ai_visualization_jobs` table —
  **recommend evaluating this before creating new tables**, since
  `job_type` is currently a fixed MySQL `ENUM('house-understanding',
  'paint-recommendation')` (line 198) and would need an `ALTER TABLE ...
  MODIFY` migration to add a third value, which is a schema change but not
  a new table.

Likely genuinely new, since nothing in the current schema represents them:
- **Per-request selection set** (surface→catalogColorId pairs submitted for
  one generation) — closest existing analog is `paint_recommendations
  .scheme_json`, but that's a *generated* recommendation, not a *dealer-
  submitted* request; a new `ai_visualization_selections`-shaped table (or a
  JSON column on a new visualization-jobs row) is reasonable.
- **Generated visualization result versioning** (provider, model, prompt
  version, output path, validation outcome) — `ai_jobs.output_json` could
  hold much of this, but the *image file* itself needs a real path column
  analogous to `assets.cleaned_path`, and there is currently no table
  representing "N generated visualizations per asset" (assets today have
  exactly one `cleaned_path`, singular, not a collection).

No migration in this repo has any production data to protect — `schema.sql`
line 55-58 explicitly notes this is "still pre-release scaffold," and
`DROP TABLE IF EXISTS job_results/visualization_jobs` already happens
unconditionally at the top of the Visualizer Module section. **This lowers
the risk of Stop-Condition G (migration causing production-data loss) for
this repo specifically** — but should still be re-confirmed with the user
before any new `DROP`/`ALTER` runs, since "no data to preserve" was true as
of when that comment was written, not necessarily true today.

---

## 12. Reusable Components (summary)

- Catalog CRUD + `paints.id` as canonical color reference — reuse directly.
- `layers` + mask-on-disk pattern + idempotent AI-surface upsert — reuse
  directly as the "precision refinement" layer the new spec wants.
- `ai_jobs` versioned-run audit table — reuse directly, likely just add a
  `job_type` enum value.
- Provider-registry pattern (`aiRegistry.service.js`) — reuse the *pattern*
  directly for a new `'house-visualization'` capability; add a
  `geminiVisionProvider.js`-equivalent file, register it, done — no changes
  needed to routes/controllers/frontend per the registry's own stated design
  goal (header comment, line 6-8).
- Surface-detection UI shell (`SurfacesTab.jsx`, `AIAnalyzeTab.jsx`) and
  scheme UI (`RecommendationsTab.jsx`) — reusable as the base for the new
  spec's Section 11 dealer surface-selection UI, though the interaction
  model shifts from "apply immediately" to "build a selection set, then
  generate."
- `colorEngine.js` LAB recolor engine — becomes the Section 22-24 refinement
  layer, unchanged in its own logic.

## 13. Obsolete / Deprecated Components

- `replicate-vision` provider — deprecate per spec Section 28 (see §1
  table above); not dead code today (still registered, still selectable),
  just should receive no further investment.
- Nothing else in the current AI surface is obsolete — the repo is young
  (all AI work postdates a single recent feature branch per `git log`) and
  every other provider/table/component maps cleanly onto a role the new
  spec still needs.

---

## Items Flagged for the User Before Phase 1 (potential Stop Conditions)

1. **Stop Condition E precedent already exists in-repo, unresolved**: the
   *current* primary house-understanding provider (`fal-vision`) has an
   explicitly-unverified core API assumption (data-URI upload) per its own
   source comment — it has apparently never been confirmed against a real
   fal.ai call. This isn't about Gemini, but it means "reliable masks"
   cannot yet be asserted for the *existing* segmentation path either,
   which the new spec's manual-refinement layer (Sections 22-23) depends on
   regardless of which image-generation provider is primary. Recommend
   resolving/testing this alongside (not blocking) the Gemini POC.
2. **No `finish` attribute on catalog colors** (schema gap, §3 above) — the
   new spec's Section 4 example payload assumes catalog colors carry
   `finish`; today `finish` is layer-level only. Not a blocker, but the
   prompt builder (Section 14) needs a decision: pull finish from the
   layer/selection instead of the catalog record, or add the column.
3. **No async job-queue infrastructure exists yet** (§10 above) — the new
   spec's Section 19 job-lifecycle model (queued→preparing→generating→
   validating→completed) has no direct precedent in this codebase; the
   closest thing (`ai/process` + `ai/status`) is a synchronous
   run-to-completion orchestrator polled for status, not a true resumable
   background job. This is real new infrastructure work, not a reuse case —
   worth sizing explicitly before Phase 3 planning assumes it's "mostly
   there."
4. **`ai_jobs.job_type` is a fixed MySQL ENUM** — adding a
   `'house-visualization'` job type requires an `ALTER TABLE ... MODIFY`
   migration (small, low-risk given no production data per §11, but still
   a schema change to flag explicitly per Section 36's "use migrations"
   instruction).

No finding here rises to a full Stop Condition (A-D, F, H) — nothing
observed contradicts an assumption the new spec makes about Gemini itself,
because Gemini has not yet been touched by any code in this repo.
