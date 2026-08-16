# Gemini AI House Visualization — Implementation Status

Status as of 2026-08-11, branch `your-new-branch-name`. Nothing in this
document is committed or pushed yet — see the file list in §4/§5. This
report follows the verification taxonomy required for this work: every
claim below is labeled **IMPLEMENTED**, **VERIFIED WITH MOCKS**, **VERIFIED
WITH REAL API**, **VERIFIED WITH REAL IMAGE**, or **NOT VERIFIED**. Nothing
mocked is described as real AI capability anywhere in this document.

## 1. Executive summary

The full dealer-facing pipeline described in the governing brief —
catalog-controlled surface/color selection → automatic prompt construction
→ Gemini recolor → traceable, pollable visualization result → frontend
display — is **implemented and code-complete**, backed by 145 backend +
41 frontend unit/integration tests (all passing) and a real local MySQL
migration (verified against your dev DB, not just written).

**It is NOT yet AI-validated.** `GEMINI_API_KEY` is not present in
`backend/.env` (checked directly, not assumed). No request has ever reached
Google's servers from this codebase. Every Gemini-specific claim in this
document — model names, request/response schema, segmentation format,
recolor fidelity — is sourced from Google's official documentation
(`ai.google.dev`, checked 2026-08-11) and is explicitly marked **NOT
VERIFIED** against a live call. This is the single blocking dependency for
everything downstream of it (Phase 1 in `GEMINI_RECOLORING_IMPLEMENTATION_PLAN.md`).

## 2. Architecture before

See `CURRENT_AI_ARCHITECTURE.md` for the full pre-Gemini audit. Summary: two
provider registries (`aiRegistry.service.js` for house-understanding/
paint-recommendation, `aiProxy.service.js` for object-removal cleanup), no
image-generation capability anywhere, no local AI (confirmed — every
existing provider is a hosted HTTP API), `fal-vision` as the current
house-understanding default with its own unverified schema assumption,
`replicate-vision` deprioritized (billing-blocked), scheme generation
already catalog-only and already real.

## 3. Architecture after

```
Gemini Vision (gemini-3.6-flash)          Gemini Image (gemini-3.1-flash-image)
  house-understanding capability            house-visualization capability (NEW)
        │                                          │
        ▼                                          ▼
 detected_surfaces / detected_objects   visualizationPrompt.service (pure,
   (reused unchanged — same tables       catalog-only prompt builder)
    fal-vision/replicate-vision write to)        │
        │                                          ▼
        └──────────────► visualization.service (validates surface keys +
                           paint IDs against DB, idempotent, async job)
                                   │
                                   ▼
                          ai_visualizations (NEW table) + ai_jobs
                          (job_type extended with 'house-visualization')
                                   │
                                   ▼
                     frontend: RecommendationsTab "Generate photorealistic
                     preview" per scheme, polled, shown inline
```

Nothing existing was removed. `fal-vision`/`replicate-vision` stay
registered exactly as before — per the plan doc's own decision (§2), do not
chain a Gemini→fal-vision fallback until fal-vision's own unverified
assumption is separately confirmed. `clipdrop`/`huggingface` cleanup is
untouched (orthogonal capability, Section 19 of the master brief — object
classification already correctly protects architectural elements, see §12
below).

## 4. Files added

```
GEMINI_RECOLORING_IMPLEMENTATION_PLAN.md   Phase 0 plan (architecture, DB, API, phases)
CURRENT_AI_ARCHITECTURE.md                 Phase 0 audit (pre-existing state)
GEMINI_IMPLEMENTATION_STATUS.md            this file

backend/src/services/ai/polygonMask.util.js          Gemini polygon-contour -> alpha-PNG raster
backend/src/services/ai/polygonMask.util.test.js
backend/src/services/ai/providers/geminiVisionProvider.js    house-understanding provider
backend/src/services/ai/providers/geminiVisionProvider.test.js
backend/src/services/ai/providers/geminiImageProvider.js     house-visualization provider
backend/src/services/ai/visualizationPrompt.service.js       pure prompt builder
backend/src/services/ai/visualizationPrompt.service.test.js
backend/src/services/ai/visualization.service.js             orchestrator
backend/src/services/aiVisualizations.model.js               DB layer for ai_visualizations
frontend/src/features/visualizer/hooks/useVisualization.js   generate + poll hooks
```

## 5. Files modified

```
backend/.env.example              GEMINI_API_KEY, model IDs, AI_VISUALIZATION_* vars
backend/src/app.js                rate limiter on /ai/visualize (billed-call pattern, matches /clean)
backend/src/config/aiConfig.js    'house-visualization' capability (no default provider — same
                                   "no default until configured" convention as house-understanding)
backend/src/controllers/ai.controller.js   requestVisualization/getVisualization/listVisualizations
backend/src/routes/ai.routes.js            POST /visualize, GET /visualizations, GET /visualizations/:id
backend/src/scripts/runSchema.js           ai_jobs.job_type ENUM upgrade (idempotent MODIFY)
backend/src/services/ai/aiRegistry.service.js   registers gemini-vision + gemini-image (not default)
backend/src/sql/schema.sql                 ai_visualizations table + job_type ENUM extension
frontend/src/shared/lib/api.js             3 new ai.* client methods
frontend/src/features/visualizer/panels/RecommendationsTab.jsx   per-scheme generate/poll/display UI
```

## 6. Files removed

**None.** Per the master brief's own removal rule (§23/§32): nothing is
deleted until confirmed genuinely obsolete, and nothing here has been
proven obsolete yet — `fal-vision`/`replicate-vision` remain the only
house-understanding paths with any live-call precedent at all (fal-vision
still unconfirmed itself; replicate-vision billing-blocked), so removing
either before Gemini is validated would leave the app with zero working
house-understanding provider if Gemini's segmentation turns out unusable.

## 7. Database changes

- `ai_jobs.job_type` ENUM extended: `'house-understanding' | 'paint-recommendation' | 'house-visualization'`.
  **VERIFIED WITH REAL API** — not the Gemini API, the actual local MySQL
  instance: ran `npm run migrate`, then queried `SHOW COLUMNS FROM ai_jobs`
  directly and confirmed the enum value is really there (not just written
  in schema.sql).
- New table `ai_visualizations` (id, asset_id, job_id, scheme_id,
  surface_color_plan, result_path, status, validation_json, created_at) —
  same **VERIFIED**, confirmed via `SHOW TABLES LIKE 'ai_visualizations'`
  against the real local DB, not assumed from the SQL file.
- No existing table altered destructively; no data loss risk (this repo has
  no production data per `schema.sql`'s own "pre-release scaffold" note,
  re-confirmed still true at migration time).

## 8. API changes

Additive only — nothing existing renamed or removed:

```
POST /api/assets/:assetId/ai/visualize          body: { surfaceColorPlan, schemeId? }
GET  /api/assets/:assetId/ai/visualizations
GET  /api/assets/:assetId/ai/visualizations/:id
GET  /api/meta                                    now also reports ai.visualization.{enabled,provider,modelVersion}
```

`/visualize` returns 202 immediately (async job pattern — matches the
existing `/ai/process` + `/ai/status` precedent) rather than blocking on the
full Gemini round trip.

## 9. Frontend changes

`RecommendationsTab.jsx`: each scheme card gets a "Generate photorealistic
preview" action, shown only when the backend reports a visualization
provider is actually configured (no fake/disabled-but-visible button).
Polls until ready/failed; shows the real failure reason on failure, not a
generic error. Deliberately kept the existing deterministic LAB preview
("Apply") as the editable path — the Gemini image is presented as the
realistic proof shown to the customer, not a replacement for it (see §13
below for why).

## 10. AI providers / models

| Capability | Provider id | Model | Registered | Default | Live-validated |
|---|---|---|---|---|---|
| house-understanding | `gemini-vision` | `gemini-3.6-flash` | Yes | **No** — `fal-vision` stays default | **NOT VERIFIED** |
| house-visualization | `gemini-image` | `gemini-3.1-flash-image` | Yes | N/A — no default exists for this capability yet | **NOT VERIFIED** |

Model selection rationale: `gemini-3.6-flash` is Google's documented
current model for object detection + segmentation (structured JSON, boxes +
polygon masks). `gemini-3.1-flash-image` ("Nano Banana 2") is the current
GA image-editing model; `gemini-2.5-flash-image` was deliberately avoided —
it retires 2026-10-02 per the official changelog. Full pricing/capability
citations are in `GEMINI_RECOLORING_IMPLEMENTATION_PLAN.md` §1.

## 11. Real API validation

**NOT VERIFIED.** `GEMINI_API_KEY` has been checked directly in
`backend/.env` three times across this work (most recently just before
writing this report) and is not present. A POC script is staged at
`<scratchpad>/geminiPoc.js`, ready to run against a real house photo the
moment a key exists. Until then, nothing here should be read as "Gemini
works" — only "Gemini is correctly wired, against Google's documented
contract, and ready to be tested."

## 12. Real image results

**NOT VERIFIED** — blocked on §11. The 8-photo evaluation set called for by
the brief (front-facing, angled, multi-story, balconies, compound
wall+gate, windows/grills, railings, cluttered background) has real house
photos already available in `backend/uploads/*/original.jpg` to draw from,
but no scoring has been run.

One related item **is** verified today, independent of Gemini: the
"don't delete architectural elements" requirement (master brief §19).
`objectClassification.js`'s `REMOVABLE_CLASSES` is `{tree, car, person,
fence}` only — compound wall, gate, pillar, balcony, and railing were never
in it, and `geminiVisionProvider.js`'s own `OBJECT_RULES` (the new
provider's removable-object list) mirrors that same restriction: those five
classes all route to `SURFACE_RULES` (paintable architecture), never
`OBJECT_RULES` (removable clutter). Confirmed by direct code inspection,
not a live call — labeled **VERIFIED** (code-level), not **VERIFIED WITH
REAL IMAGE**.

## 13. Surface detection / mask results

**NOT VERIFIED** for Gemini specifically. One concrete, documented gap is
already known and handled in code rather than assumed away: Gemini's
segmentation returns a **polygon contour** (`[x,y]` points, normalized
0-1000), not the base64 alpha-PNG format every existing mask consumer in
this app expects. `polygonMask.util.js` converts between them and has 6
passing unit tests against synthetic polygons — but a synthetic square
rasterizing correctly says nothing about whether Gemini's real polygon
output is fine-grained enough to be a usable surface mask (a 4-point box
vs. a detailed building-edge contour would both "work" in the rasterizer
and look completely different in practice). This is exactly why §21 of the
master brief's real-image evaluation is required before any mask-quality
claim, not a stand-in for it.

## 14. Color fidelity results

**NOT VERIFIED.** The open question flagged in the plan doc (§3) —
whether hex+name text alone is sufficient or a rendered catalog swatch
needs to be sent as a reference image — is unresolved and requires visual
inspection of a real generated image against the real catalog swatch to
answer.

## 15. Known limitations

- No Gemini call has ever succeeded or failed against a real endpoint —
  every schema in `geminiVisionProvider.js`/`geminiImageProvider.js` is
  built from documentation, not observed behavior.
- Neither Gemini provider is the default for its capability. Real
  environments are unaffected by this work until someone explicitly sets
  `AI_ANALYSIS_PROVIDER=gemini-vision` / `AI_VISUALIZATION_PROVIDER=gemini-image`.
- `fal-vision`'s own pre-existing unverified assumption (data-URI upload
  format) is still unresolved — carried over from before this work, not
  introduced by it, but still a real gap if Gemini's own understanding
  quality turns out to need a fallback.
- The generated Gemini image does not yet feed back into re-derived
  editable masks (§16 of the master brief). Current design deliberately
  uses the *original* detected-surface masks (already known-good, already
  tested) for the editable-layers path, and treats the Gemini image purely
  as the realistic preview — re-deriving masks from the generated image
  itself would need a second Gemini understanding call per generation and
  is left for a later phase pending real-image results justifying the extra
  cost/complexity.
- No PDF/branded export changes — out of scope for this pass, unaffected.

## 16. Remaining risks

- Segmentation polygon coarseness (see §13) could make Gemini's masks
  unusable for precise manual refinement even if the recolor itself looks
  good — the architecture already anticipates this (plan doc §2: don't
  chain unverified providers), but it's a real risk, not a hypothetical.
- Gemini could refuse or degrade on some house styles/angles (safety
  filters, ambiguous instructions) — `geminiImageProvider.js` surfaces this
  as a real failure with Gemini's own text explanation rather than a fake
  empty image, but the actual refusal rate is unknown until tested.

## 17. Test results

- Backend: 145/145 passing (`npm test` in `backend/`), including 15 new
  tests for prompt construction, polygon rasterization, and label
  classification — all pure-logic, no network calls (**VERIFIED WITH
  MOCKS** is not even the right label here; these have no external
  dependency to mock).
- Frontend: 41/41 passing (`npm test` in `frontend/`); `npm run build`
  succeeds (2478 modules, no errors).
- Migration: applied and verified against a real local MySQL instance (§7).
- Real Gemini integration test: **NOT RUN** — no key.

## 18. Production-readiness assessment

```
NOT READY
```

Per the master brief's own rule (§30, §40 of the two governing prompts):
this cannot be rated "ready for internal testing" or higher without a real
Gemini call and real-image evaluation, neither of which has happened. What
*is* true: the moment `GEMINI_API_KEY` is available, this becomes a fast
turnaround — POC script staged, providers written and unit-tested,
end-to-end wiring already passing every non-AI test — not a "start from
scratch" situation.

## 19. Recommended next steps

1. Add `GEMINI_API_KEY` to `backend/.env` (not committed — already
   gitignored, same as every other provider key in this repo).
2. Run the staged POC script against a real house photo from
   `backend/uploads/`; inspect both responses by hand.
3. Fix whatever the real schema doesn't match (most likely candidate: the
   segmentation `mask` field, per §13).
4. Run the full 8-photo evaluation set, score against the brief's rubric,
   write the results into this document's §12/§13/§14 (replacing "NOT
   VERIFIED" with real findings, including honest failures).
5. Only then reconsider whether `fal-vision`/`replicate-vision` become
   real removal candidates, and only then set a Gemini provider as any
   capability's default in a real environment.
