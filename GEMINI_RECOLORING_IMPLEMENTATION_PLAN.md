# Gemini Recoloring — Implementation Plan

Phase 0 deliverable. Read-only: no application code changed to produce this
document (the only working-tree change alongside it is an unrelated security
fix — a leaked HF key redacted in `IMPLEMENTATION_BASELINE.md`).

This document assumes `CURRENT_AI_ARCHITECTURE.md` (repo root) as ground
truth for current-state findings and does not repeat it in full — read that
file first. This document adds the forward-looking piece: the proposed
Gemini architecture, concrete changes per layer, phases, and acceptance
criteria, grounded in Gemini's actual documented capabilities (checked
2026-08-11 against `ai.google.dev`, not assumed from training data).

---

## 1. Gemini capability findings (verified against official docs)

| Capability | Model(s) | Status |
|---|---|---|
| Image generation/editing | `gemini-3.1-flash-image` ("Nano Banana 2"), `gemini-3-pro-image` ("Nano Banana Pro"), `gemini-3.1-flash-lite-image` | GA as of 2026-05-28 / 2026-06-30 |
| Legacy image gen | `gemini-2.5-flash-image` | Still works, **retires 2026-10-02** — do not build on it |
| Image understanding + object detection + segmentation | e.g. `gemini-3.6-flash` (vision-capable text model) | GA; documented, not yet live-tested by this repo |

**Editing existing photos**: all image-gen models take an input image + text
instruction and "add, remove, or modify elements, change the style, or
adjust color grading." Recommended prompt pattern per Google's own docs:
*"change only the [element] to [new value]. Keep everything else in the
image exactly the same."* This is a semantic instruction, not a pixel mask —
Gemini itself decides which pixels "the wall" refers to during generation.
This directly matches this project's Section 17 preservation requirement,
but means **fidelity has to be validated empirically per Phase 1**, not
assumed from the docs.

**Segmentation** (separate from image generation): Gemini vision models
support structured object detection and segmentation via prompted JSON
output — documented schema:
```json
{ "boxes": [ { "box_2d": [ymin, xmin, ymax, xmax], "mask": [[x,y], ...], "label": "wall" } ] }
```
Boxes are `[ymin, xmin, ymax, xmax]` normalized 0–1000; `mask` is a
**polygon contour** (list of `[x,y]` points, also normalized 0–1000) —
**not** a base64 PNG alpha mask. This is a materially different shape than
every existing mask in this repo (`detected_surfaces.mask_path`,
`layers.mask_path`, all binary alpha PNGs per `CURRENT_AI_ARCHITECTURE.md`
§5). A polygon-to-raster conversion step is required before a Gemini
segmentation result can populate `detected_surfaces.mask_path` or a
`layers.mask_path` the same way `maskOps.js` does today — this is
straightforward (point-in-polygon rasterization, already a category of
logic `maskGeometry.js` has for polygon-tool masks) but is new glue code,
not a drop-in replacement.

**No response has been observed from a live call yet** — the docs describe
the contract, but per this project's Section 40 ("no fake success"), this
schema is *documented*, not *integration-tested*, until Phase 1 runs a real
request against a real house photo and the output is inspected.

**Pricing** (per official pricing page, confirm again at Phase 1 since these
move roughly monthly): `gemini-3.1-flash-image` ≈ $0.045/image at 512px up
to $0.15/image at 4K; `gemini-3-pro-image` ≈ $0.13–0.24/image; understanding
calls (`gemini-3.6-flash` as vision/text) bill at standard token rates
(~$1.50/1M input). A single recolor job doing 1 understanding call + 1
generation call at 1K resolution is roughly $0.03–0.10 depending on model
tier — cheap enough per-image that per-scheme regeneration (Section 22) is
viable without aggressive caching, but caching is still worth doing (§13
below) since dealers will iterate.

**Sources**: [ai.google.dev/gemini-api/docs/image-generation](https://ai.google.dev/gemini-api/docs/image-generation), [ai.google.dev/gemini-api/docs/image-understanding](https://ai.google.dev/gemini-api/docs/image-understanding), [ai.google.dev/gemini-api/docs/pricing](https://ai.google.dev/gemini-api/docs/pricing), [ai.google.dev/gemini-api/docs/changelog](https://ai.google.dev/gemini-api/docs/changelog)

---

## 2. Architecture decision

**Gemini does both house understanding and image generation.** Both
capabilities live in one provider family (same API, same billing, one fewer
external dependency than a Gemini+fal hybrid), which resolves the "hybrid
pipeline" question in Section 12 of the governing brief in Gemini's favor
*if* Phase 1's live test confirms segmentation quality is usable — that is
the actual open question, not which vendor to call.

Fallback posture for existing providers (extends
`CURRENT_AI_ARCHITECTURE.md` §1 KEEP/DEPRECATE table, unchanged unless Phase
1 finds Gemini segmentation unusable):

- `catalog` / `hf-scheme` (paint-recommendation) — **unchanged**, still the
  scheme-generation layer, orthogonal to image synthesis.
- `fal-vision` (house-understanding) — **kept registered, not made the
  fallback yet**. It has its own unverified assumption
  (`CURRENT_AI_ARCHITECTURE.md` §1a). Do not build a Gemini-fails→fal-vision
  fallback chain until fal-vision's own live call is confirmed — chaining
  two unverified providers compounds risk instead of reducing it.
- `replicate-vision` — unchanged, still deprioritized (billing-blocked).
- `clipdrop` / `huggingface` (cleanup) — unchanged, orthogonal capability.
  Gemini image-editing *could* replace ad-hoc object cleanup later (Section
  14 of the brief), but that's a second decision after the core recolor
  path is proven, not a Phase 1–3 concern.

**New providers**, following the existing `aiRegistry.service.js` pattern
exactly (`backend/src/services/ai/providers/<id>.js` + one line in
`PROVIDERS`, per that file's own stated design goal — no route/controller
changes needed to register a provider):

- `gemini-vision` — capability `house-understanding`. Produces the same
  normalized shape `houseUnderstanding.service.js` already expects
  (surfaces/objects with `class_key`, `confidence`, mask, geometry), so it
  slots into the existing `detected_surfaces` / `detected_objects` tables
  unchanged.
- `gemini-image` — **new capability**, `house-visualization` (does not
  exist today; `aiConfig.js` currently only knows
  `house-understanding`/`paint-recommendation`). Takes `{ imageBuffer,
  surfaceColorPlan }`, returns a generated image buffer.

---

## 3. Prompt construction (Section 5–7 of the brief)

New service: `backend/src/services/ai/visualizationPrompt.service.js`.
Pure function: `buildRecolorPrompt(surfaceColorPlan, houseContext) → string`.
Input is the structured selection (surface key → `paints.id`), resolved
against the catalog exactly like `paintRecommendation.service.js` already
resolves scheme paint IDs (`resolveScheme`, joins to full paint row — reuse
this, don't duplicate the join).

Per-surface instruction line: `"{displayName}: change to {color_name}
({hex_value})."` — hex from the catalog's generated column, never invented.
Fixed preservation clause appended once, not per-surface (Section 17):
geometry/perspective/windows/doors/roof/proportions/lighting/shadows/
texture/material preserved, no structural invention. No raw user text ever
reaches this string — the dealer only ever picks catalog IDs, matching
Section 7's "no arbitrary user text controls the core prompt" rule.

**Color fidelity (Section 16) — flagged as a Phase 1 experiment, not a
foregone decision**: test hex-name-only vs. hex+name+a rendered swatch
image passed as a second reference image (Gemini image models accept up to
14 reference images). Only add the swatch-image path if Phase 1 shows text
hex alone drifts from the catalog color — extra reference images have real
cost, so this is decided by results, not by default.

---

## 4. Database changes

Extends `CURRENT_AI_ARCHITECTURE.md` §11's analysis, which already
identified these as the two real gaps:

1. **`ai_jobs.job_type` ENUM** (`schema.sql:198`) needs a third value:
   `ALTER TABLE ai_jobs MODIFY job_type ENUM('house-understanding',
   'paint-recommendation', 'house-visualization') NOT NULL;`. Low risk —
   `schema.sql:55-58` already documents no production data exists yet in
   this repo, but this still gets a proper migration file and a stop before
   running it against any environment with real dealer data (re-confirm
   `schema.sql`'s "pre-release scaffold" note is still true when this
   actually runs, per that file's own caveat).
2. **New table for generated visualization results**, since `assets` today
   has exactly one `cleaned_path` (singular) and there's no table for "N
   generated visualizations per asset" (`CURRENT_AI_ARCHITECTURE.md` §11):

```sql
CREATE TABLE IF NOT EXISTS ai_visualizations (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    asset_id            VARCHAR(36) NOT NULL,
    job_id              INT NOT NULL,              -- ai_jobs row (provider, model, timing, failure_reason already tracked there)
    scheme_id           INT NULL,                  -- paint_recommendations.id, if generated from a saved scheme rather than an ad-hoc selection
    surface_color_plan  JSON NOT NULL,              -- { surfaceKey: paintId } snapshot actually sent to Gemini — traceability even if the scheme changes later
    result_path         VARCHAR(500) NOT NULL,      -- generated image, same storage.service convention as original.jpg/cleaned.jpg
    status              ENUM('pending','ready','failed') NOT NULL DEFAULT 'pending',
    validation_json      JSON NULL,                 -- Phase 11 quality-gate output (geometry/color/mask usability), not just "provider said 200 OK"
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_viz_asset FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
    CONSTRAINT fk_viz_job FOREIGN KEY (job_id) REFERENCES ai_jobs(id) ON DELETE CASCADE,
    CONSTRAINT fk_viz_scheme FOREIGN KEY (scheme_id) REFERENCES paint_recommendations(id) ON DELETE SET NULL,
    KEY idx_viz_asset (asset_id)
) ENGINE=InnoDB;
```

No other new tables. `detected_surfaces`/`detected_objects` are reused
as-is for Gemini's understanding output (they already have `mask_path`,
`geometry`, `confidence` — a Gemini polygon result gets rasterized to a PNG
and written to `mask_path` exactly like every other provider does today).
`paint_recommendations` is reused as-is for scheme storage — a
visualization just references a `scheme_id` optionally.

---

## 5. API changes

New, additive — nothing existing is removed or renamed
(`CURRENT_AI_ARCHITECTURE.md` §10 contract stays intact):

```
POST /api/assets/:assetId/ai/visualize      body: { surfaceColorPlan } or { schemeId }
                                              → creates ai_jobs(job_type='house-visualization') row, async
GET  /api/assets/:assetId/ai/visualizations  list ai_visualizations for the asset
GET  /api/assets/:assetId/ai/visualizations/:id
```

`POST .../analyze` is reused unchanged when the provider is switched to
`gemini-vision` via `AI_ANALYSIS_PROVIDER=gemini-vision` — no new route
needed for understanding, per the registry's own design goal.

**Async, not sync** (Section 26 of the brief, and flagged as a real gap in
`CURRENT_AI_ARCHITECTURE.md` §10 — today's `analyze`/`recommendations` are
synchronous request/response). `POST .../visualize` returns
`{ jobId, status: 'running' }` immediately; frontend polls
`GET .../visualizations/:id` the same way `useAiPipeline.js` already polls
`GET /ai/status` — same pattern, new endpoint, since visualization jobs can
run longer than a segmentation call and blocking the HTTP request for a
multi-second image-gen call would tie up a connection for no benefit.

---

## 6. Backend services (new)

```
geminiVisionProvider.js        — house-understanding provider (aiRegistry)
geminiImageProvider.js         — house-visualization provider (aiRegistry)
visualizationPrompt.service.js — pure prompt builder (§3 above)
visualization.service.js       — orchestrates: resolve plan → build prompt → call provider → rasterize/store result → write ai_visualizations row
polygonMask.util.js            — Gemini polygon contour → alpha PNG raster (new; nothing today does polygon→raster, only polygon-tool-draw→raster in maskGeometry.js, which is close but drawn-by-hand polygons, not normalized-0-1000 API output — needs its own small conversion, not a straight reuse)
```

`visualization.service.js` follows `paintRecommendation.service.js`'s
existing shape (require prior analysis, 409 if missing) rather than
inventing a new pattern.

---

## 7. Frontend changes

Reused as-is: `SurfacesTab.jsx`/`AIAnalyzeTab.jsx` (surface list UI),
catalog color picker, `RecommendationsTab.jsx` (scheme list UI),
`useApplySurface.js` (still how a *generated* result's surfaces become
editable layers afterward), `ExportPanel.jsx`.

New: a "Generate Visualization" action once the dealer has a
surface→catalog-color selection set (either from applying an existing
scheme or building one ad-hoc), a job-status poll hook mirroring
`useAiPipeline.js`, and a result view that shows the generated image with a
"convert to editable layers" action — this is the bridge described in
Section 21/22 of the brief: accepting a generated image should create
`layers` rows (via the existing `useApplySurface` path, `created_via:
'ai-surface'`) from the *generated result's* re-derived surface masks, not
leave it as a flat exported JPEG.

No redesign of the upload/project/layer/history/export shell — this is an
additive workflow step inserted between "scheme selected" and "layers
painted," not a replacement of the visualizer.

---

## 8. Failure handling, idempotency, caching, security

- Failure envelope: reuse `aiResult.js`'s existing `ok`/`fail` shape
  (`CURRENT_AI_ARCHITECTURE.md` §1a already shows this is the standard
  contract) — `{ ok:false, failureReason, stage, retryable }` per Section 27
  of the brief is what `aiResult.fail` already produces; no new envelope
  needed.
- Idempotency: `(asset_id, surface_color_plan hash)` — a repeat request with
  an identical plan reuses the existing `ai_visualizations` row instead of
  regenerating, mirroring the `uq_layers_ai_surface` pattern already used
  for AI-surface layers (`schema.sql:134`).
- Caching: same key as idempotency — this *is* the cache, no separate cache
  layer needed given `ai_visualizations` already persists results.
- Security: Gemini key server-side only (`backend/.env`, gitignored —
  confirmed already correctly configured for every other provider per
  `CURRENT_AI_ARCHITECTURE.md` §1), validate `surfaceColorPlan` surface keys
  against the asset's own `detected_surfaces` and paint IDs against the
  catalog before ever building a prompt, same asset/project ownership check
  every other `/ai/*` route already does.
- Logging: `ai.visualization.started/completed/failed` alongside the
  existing `ai.analysis.*`/`ai.recommendation.*` structured log points
  (Section 31) — same request-id correlation already wired per
  `paint_visualizer_audit_state` memory's mention of "request-id logging."

---

## 9. Testing strategy

- Unit: prompt builder output for a given plan, polygon→raster conversion
  correctness (known polygon → known mask shape), catalog-ID validation
  rejecting an unknown paint id.
- Integration: mock the Gemini HTTP boundary (same approach
  `CURRENT_AI_ARCHITECTURE.md` implies is already the pattern for the
  existing provider tests) for a deterministic
  analyze→plan→visualize→persist→layer-apply round trip.
- Real API test (Phase 1): one real call each to the understanding model
  and the image model against one real house photo, output inspected by
  hand — this is the actual capability validation, not the mocked tests.
- Real-image quality gate (Phase 11, Section 33): 8 real house photos per
  the brief's own checklist (front, angled, multi-story, compound wall,
  balconies, railings, windows/grills, cluttered background), scored on
  understanding accuracy, recolor correctness, color fidelity, geometry
  preservation, shadow preservation, texture preservation, mask usability —
  written up honestly in `GEMINI_REAL_IMAGE_EVALUATION.md` afterward, not
  claimed from mocked results.

---

## 10. Removal list

Per `CURRENT_AI_ARCHITECTURE.md` §13: **nothing is deleted in this pass.**
`replicate-vision` stays registered-but-deprioritized (already the case
today, no code change). No local AI exists to remove. `mockProvider.js`
stays as a fixture. This may change after Phase 1's live segmentation test
— if Gemini's polygon masks prove reliably better than fal-vision's
never-validated output, fal-vision becomes a real deprecation candidate at
that point, not before.

---

## 11. Implementation phases (this session's plan, phase-gated per standing rule)

Each phase stops for explicit approval before the next starts, per the
user's confirmed work-mode choice — this list is the granularity those
stops happen at, not a batch to run through unattended.

- **Phase 0 — Discovery** ✅ this document + `CURRENT_AI_ARCHITECTURE.md`.
- **Phase 1 — Gemini capability validation.** Requires a real API key
  (user providing one). Smallest real test: one `gemini-3.6-flash`
  understanding call + one `gemini-3.1-flash-image` edit call against one
  real house photo from this repo's existing uploads, output inspected by
  hand against Section 33's checklist items. **This phase can invalidate
  parts of this plan** (e.g. if segmentation polygons are unusably coarse)
  — report back before Phase 2 starts.
- **Phase 2** — `gemini-vision` provider + registry wiring, reusing
  `detected_surfaces`/`detected_objects`.
- **Phase 3** — prompt builder + `gemini-image` provider +
  `visualization.service.js` + `ai_visualizations` table/migration.
- **Phase 4** — async job route (`POST/GET .../visualize`,
  `.../visualizations`), polling, failure handling.
- **Phase 5** — frontend: generate action, poll hook, result view,
  generated-result → editable-layers bridge.
- **Phase 6** — real-image quality gate (Section 33/34), written up in
  `GEMINI_REAL_IMAGE_EVALUATION.md`.
- **Phase 7** — production hardening pass (idempotency/caching already
  designed in §8 above, revisit after real usage patterns from Phase 6).

---

## 12. Acceptance criteria

- A dealer can select a surface→catalog-color plan and get back a generated
  image without writing or seeing any prompt text.
- Every color in the generated image traces back to a real `paints.id`.
- Generated results become real `layers` rows through the existing apply
  path, not a dead-end file.
- No local AI model, no local GPU inference, anywhere in the stack.
- No Gemini key reachable from the frontend bundle or network tab.
- Real house-photo evaluation (Phase 6) actually run and documented before
  any "production ready" claim — mocked-test success alone never counts.

---

## Open items for the user (not full stop conditions, but decisions worth confirming)

1. Confirmed already: leaked HF key → redact + rotate (not scrub history).
   Redaction commit is written but blocked by the auto-mode classifier —
   needs a manual approval or a permission rule to land.
2. Gemini API key — needed before Phase 1 can run a real call. Please add
   it to `backend/.env` (gitignored) as `GEMINI_API_KEY=...` rather than
   pasting it into chat, or paste it and I'll write it there directly and
   won't echo it back.
3. Color-swatch-as-reference-image (§3 above) is left as a Phase 1
   experiment, not decided here — will report back with a recommendation
   once real output can be inspected.
