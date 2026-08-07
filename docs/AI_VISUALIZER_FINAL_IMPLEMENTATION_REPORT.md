# AI Visualizer — Final Implementation Report

**Date:** 2026-08-07. **Branch:** `feat/ai-house-understanding`. **Scope:** this session's
work only — building on an already-substantial existing app (see `DOCUMENTATION.md` for the
full pre-existing architecture/spec/audit, and `docs/AI_VISUALIZER_ARCHITECTURE_AUDIT.md` for
this session's Phase 0 findings). This is not a from-scratch build; it is incremental hardening
and feature work against a working product.

---

## 1. Original architecture

A project-centric paint-visualization platform: React/Konva frontend, Express/MySQL backend,
local-disk storage, hosted AI proxies for object removal. One renderer
(`colorEngine.applyPaintColor`, LAB-space recolor preserving shading/texture) used consistently
for live canvas, scheme previews, and export. AI house-understanding ran on a `mock` heuristic
provider by default, swappable via a provider registry. Every AI stage (analysis, recommendation,
cleanup) was a separate, manually-triggered, synchronous HTTP call with no orchestration between
them. Full detail: `DOCUMENTATION.md` §1-§9.

## 2. Problems discovered (this session's Phase 0 audit)

- AI analysis required a manual click; nothing chained analysis → recommendations automatically.
- Object removal (`/clean`) had zero house-awareness — a user-drawn mask or nothing at all.
- Surface confidences were accepted as-is, including the mock provider's fixed, non-model
  constants, with no independent validation.
- `paintRecommendation.service.js` had no audit trail (`ai_jobs` row) at all — invisible to any
  future status/observability work.
- Recommendation ranking didn't exist — the first N templates in file order were always returned,
  regardless of how well the actual catalog could realize them.
- A real, live security gap: `/files/*` served every stored photo/mask/export with **no auth**,
  despite `/api/*` already being key-gated and a real key already configured in this environment.
- A real, pre-existing correctness bug: the Excel import "transaction" never actually wrapped its
  writes (used the shared pool, not the transaction connection) — a mid-import failure left the
  catalog half-written.
- Excel Export button was a plain `<a href>` to a key-gated API route — broken (401) the moment a
  real key is configured, which it already is in this environment.
- SSRF-shaped gap in `huggingface.js`: a provider-returned URL was fetched with the HF key
  attached, no timeout, no size cap.
- Zero backend tests existed; zero `npm test` script in either package.

## 3. Changes made

### Phase 1 — Crash repair (verified, not re-done)
Already fixed and committed before this session's later work began: the AI Schemes render-time
OOM/freeze (`RecommendationsTab.jsx`) — bounded preview resolution, sequential generation,
cached data URLs, fixed compositing. See `AI_SCHEMES_CRASH_INCIDENT.md` /
`AI_SCHEMES_ACTIVATION_CRASH_FORENSIC.md`.

### Phase 2 — Autonomous AI pipeline
New `aiPipeline.service.js` chains house-understanding → paint-recommendation automatically after
upload. No new job table — derives a `idle|understanding|schemes|ready|failed` stage from the
existing `ai_jobs` rows (extended, per Rule "don't fork a second job system"). New
`POST /ai/process` (idempotent start) and `GET /ai/status` (poll) endpoints; existing
`/analyze`/`/recommendations` endpoints untouched. Frontend: `AssetsTab.jsx`'s upload handler
auto-fires the pipeline; `AiPipelineStatusBar.jsx` shows product-language progress
("Understanding your house…" / "Preparing color combinations…"), no provider/job/confidence
jargon in the primary UX. Object removal deliberately **stays manual** — a per-user product
decision made this session, not a gap.

### Phase 3 — House understanding classification
Added the brief's third axis for detected objects: `category` = `unrelated-object`
(tree/car/person/fence — safe to auto-remove) vs. `non-paintable-house-component` (window,
neighbor-house — part of the scene but never removed). Computed on read from `class_key`
(`objectClassification.js`), not persisted — no migration, always in sync with Phase 4's removal
logic since both read the same source. Surfaced in the AI Understand tab.

### Phase 4 — House-aware object removal
New `objectRemovalMask.service.js` builds a default Clipdrop-convention removal mask (white =
remove, black = keep) from the asset's own analysis when the user hasn't drawn one: unions
detected `unrelated-object` masks, then stamps every paintable surface mask back to "keep" on
top — a surface always wins even if a detection overlapped one. An explicit user-drawn mask
always takes full precedence (no merging). Falls back to today's exact prior behavior (no mask)
when there's no analysis or nothing removable was detected.

### Phase 5 — Surface quality validation
New `surfaceQuality.service.js`: scores every detected surface on model confidence, area
plausibility (per-class expected size range — a "door" the size of a wall scores low), house-bbox
containment, non-paintable-object overlap, and aspect-ratio sanity — not just the provider's own
confidence number. Stored in the existing `properties` JSON column (no migration). Surfaces
scoring below threshold still appear in the AI Understand tab (badged "Needs review") but are
excluded from automatic scheme generation (`paintRecommendation.service.js` filters on
`quality.tier`).

### Phase 6/7/9 — Rendering, catalog sourcing, preview-matches-apply
Verified only, no code: single-renderer invariant intact (`applyPaintColor` still called from
exactly `LayerNode`, `renderSchemePreview`, `ExportPanel`), catalog-only paint sourcing intact,
scheme previews still match what Apply produces (Phase 1's fix). Already satisfied before this
session for the most part.

### Phase 8 — Scheme generation ranking
`catalogRecommendationProvider.js` now builds and scores **every** template (not just the first
`schemeCount` in file order), ranking on catalog fit (how close the actual catalog's nearest
paint is to each role's color-theory target) and wall/trim/door contrast, returning the top N.
A house whose catalog can't realize "Coastal Breeze" well now ranks it lower instead of always
returning the same fixed menu regardless of context. Score persisted in `paint_recommendations.
rationale.score`.

### Phase 10/11 — UI/UX and manual customization
Verified, not redesigned (Rule: don't rewrite working UI): the existing side-panel IA (Assets /
Layers / History / AI Understand / AI Schemes tabs) plus this session's status bar already satisfy
"hide AI jargon from the primary UX." Manual surface picking, per-surface color editing, and
layer-based editing were already real and unchanged.

### Phase 12 — Persistence/transaction correctness
Fixed the Excel import transaction bug for real: `paints.model.js`'s `create`/`update`/`getById`
now accept an optional DB executor (default the pool, but `commitImport` passes its transaction
connection) — a mid-import failure now actually rolls back every write, not just the audit log
row. Also fixed: re-importing a soft-deleted color no longer crashes on the unique constraint
(revives it instead); resolved the Excel `id`/`s_id` ambiguity as a documented decision, not an
open TODO; scheme-apply failures now tell the user their partial progress is safe to resume
(leaning on the pre-existing idempotent upsert) instead of a generic error.

### Phase 13 — Performance
Eyedropper LAB conversion precomputed once per catalog load instead of recomputed for up to 2000
paints on every click.

### Phase 14 — Security hardening
- `/files/*` now requires the same access key as `/api/*` (header or, since `<img src>` can't
  attach headers, a `?key=` query param — accepted only on this route).
- Path-traversal guard in `storage.service.js` rewritten to use `path.relative` containment
  instead of a bypassable `string.startsWith` check.
- `huggingface.js`'s provider-URL image fetch now goes through a new `getWithLimits` helper
  (timeout + a real streamed byte cap, not just a `Content-Length` check) — closes the SSRF/
  key-leak/unbounded-download gap.
- Catalog Export fixed to fetch-as-blob-and-download instead of a plain `<a href>` that 401s
  under a real key.
- `docker-compose.yml` now actually passes through `API_ACCESS_KEY`/AI provider env vars (it
  never did before — even a user who set them in their shell had no way to get them into the
  container); default behavior (open, local-dev) is unchanged when unset.
- **Not done, cannot be done by me:** rotating the live, previously-leaked HF key — that requires
  the user's own HF account access.

### Phase 15 — Tests
Added `npm test` (`node --test`, previously absent from both packages) plus 21 new backend unit
tests (surface quality scoring, object classification, pipeline stage derivation, path-traversal
guard) and confirmed the existing 7 frontend tests still pass. Not full coverage — targeted at
this session's new/changed logic, as scoped.

### Phase 16 — Visual QA
**Could not be completed as browser-rendered visual QA** — the Claude-in-Chrome extension is not
connected in this environment (same limitation noted in prior session memory). What I could and
did do: a full API-level, database-backed, end-to-end smoke test of the real pipeline (upload →
auto-process → understanding → quality-scored surfaces → ranked schemes → recommendations
readable), re-run against a freshly-restarted server to rule out stale-process false positives,
plus static build verification of both frontend and backend. **No pixel-level UI confirmation was
performed.** This is a known limitation, not a claim of completion.

### Phase 17 — This report

---

## 4. AI pipeline — before vs. after

**Before:** Upload → *(user clicks "Understand this photo")* → analysis → *(user clicks
"Generate N schemes")* → recommendations → *(user clicks Apply)*.

**After:** Upload → automatic analysis → automatic recommendations → user sees a progress bar in
product language, then browses ranked, quality-gated schemes and applies. The manual buttons
still exist and still work (re-analyze, regenerate) — nothing removed, only automated on top.

## 5. Models/providers actually used

Unchanged by this session except for the honesty/observability layer around them — see
`docs/AI_VISUALIZER_ARCHITECTURE_AUDIT.md` §3 for the full verified inventory. Headline: the live
default (`AI_ANALYSIS_PROVIDER` unset in `.env`) is still the `mock` heuristic, not a trained
model. `hf-vision` (hosted Grounded-SAM2, added just before this session) remains **unverified
against a live HF endpoint** — flagging again here since it's the kind of claim Rule 34 exists to
prevent silently going stale.

## 6. Object removal architecture

New this session: house-aware default masking (Phase 4). Object removal itself (the actual
inpainting call) is unchanged — still external (Clipdrop/HF), still manual/optional per this
session's explicit product decision, not folded into the automatic pipeline.

## 7. Surface segmentation architecture

Segmentation itself (which pixels belong to which surface) is unchanged — still whichever
provider is configured. New: an independent quality gate on top (Phase 5), so "the model returned
a mask" and "the mask is trustworthy enough to auto-generate a scheme from" are no longer treated
as the same thing.

## 8. Paint rendering architecture

Unchanged (already satisfied — single LAB-blend renderer, verified intact).

## 9. Recommendation architecture

Was: fixed-order template selection. Now: candidate generation over all templates, scored on
catalog-fit and wall/trim/door contrast, ranked, top N returned. Still 100% catalog-only,
still zero invented colors — the ranking changes *which* real schemes get shown, never *what*
they're made of.

## 10. Database changes

**None requiring a migration.** Every new field (`surfaces[].properties.quality`,
`objects[].category`, `schemes[].rationale.score`) is either stored in an existing JSON column or
computed on read from data already there. `schema.sql` untouched.

## 11. API changes

Additive only: `POST /ai/process`, `GET /ai/status`. Every existing endpoint's request/response
shape is unchanged (new fields are additions inside existing JSON objects, nothing removed or
renamed) — existing consumers are unaffected.

## 12. Frontend changes

`AiPipelineStatusBar.jsx` (new), `useAiPipeline.js` (new hook), auto-trigger wired into
`AssetsTab.jsx`, quality/category badges added to `AIAnalyzeTab.jsx`, scheme-apply error message
improved in `RecommendationsTab.jsx`, catalog export fixed in `CatalogPage.jsx`, eyedropper
LAB precompute in `VisualizerWorkspace.jsx`. No component was rewritten — every change is additive
to existing, working components.

## 13. UX changes

A visible progress indicator now exists between "upload" and "schemes appear," in plain language.
Detected surfaces and objects now carry a review/removability signal a dealer can act on. No
navigation, layout, or workflow structure changed.

## 14. Performance improvements

Eyedropper catalog scan is O(1) LAB lookups per click instead of O(catalog size) conversions per
click. Nothing else in this session's scope — the bigger backlog items (Web Worker paint
compositing, analysis caching) remain future work, listed in `DOCUMENTATION.md` §12.

## 15. Security improvements

Closed: unauthenticated file serving, weak path-traversal guard, SSRF-shaped provider-URL fetch,
broken catalog export under a real key, compose env passthrough gap. Still open, not addressable
without the user: the previously-leaked HF key needs rotation on their HF account; the access-key
system still fails open when unset (an explicit, documented local-dev convenience, not a bug I
introduced or was asked to remove).

## 16. Testing results

Backend: 21/21 new tests pass (`npm test` in `backend/`). Frontend: 7/7 existing tests pass
(`npm test` in `frontend/`, script added this session). Both production builds succeed. Full
pipeline verified live against a real (freshly-restarted, to rule out stale-process artifacts)
dev server and MySQL database — see the smoke-test transcript in this session's history for the
exact requests/responses.

## 17. Visual QA results

**Not performed** — Claude-in-Chrome extension unavailable in this environment. This is the one
acceptance-criterion category (Section 38's "Visual QA passes") this report cannot honestly claim.

## 18. Remaining limitations

- `hf-vision` provider unverified against a live endpoint (Phase 0 finding, unchanged).
- Object removal is not part of the automatic pipeline (explicit product decision, not a gap).
- No visual/screenshot-based QA was possible this session.
- Everything already listed as open in `DOCUMENTATION.md` §9 that this session didn't touch
  remains open (e.g. `/files/*`'s access-key-unset-is-open default is unchanged by design; RBAC;
  PDF export; storage-layout normalization).
- Recommendation ranking (Phase 8) is still a rules-based scorer, not a learned or VLM-assisted
  one — a real quality improvement over fixed-order selection, but not a different category of
  system.

## 19. Production readiness assessment

**Not a full production-readiness clearance.** This session closed the concrete, well-specified
gaps that were actually fixable without new product decisions or the user's own credentials
(security P0/P1s, a real correctness bug, missing tests, missing automation, missing validation
layers) and made real, verified quality improvements to the AI pipeline (autonomy, validation,
ranking, house-aware removal). It did **not**: rotate the leaked key, verify `hf-vision` live,
perform visual QA, or address the larger deferred items already tracked in `DOCUMENTATION.md`
(RBAC, PDF export, storage layout, multi-user). Distinguish what changed here from what remains —
this report and `docs/AI_VISUALIZER_ARCHITECTURE_AUDIT.md` together are the accurate record of
both.
