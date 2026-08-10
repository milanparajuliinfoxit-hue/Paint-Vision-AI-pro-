# AI Visualizer — Architecture Audit (Phase 0)

**Date:** 2026-08-07. **Scope:** deep codebase discovery only — no code changed while writing
this. Companion to the pre-existing `DOCUMENTATION.md` (consolidated spec/audit/API reference,
2026-08-05, refreshed 2026-08-07), which this file cross-references rather than duplicates. Read
that file for line-level detail; this file answers the 13 questions the governing brief asks for
and states the phase-gate verdicts.

---

## 1. Current architecture

Three-tier: React/Vite/Konva frontend → Express/MySQL backend → hosted AI proxies (object
removal only). See `DOCUMENTATION.md` §2 for the full stack table and `§2.4` for the five
invariants (single renderer, AI never paints, idempotent AI layers, masks-as-files,
storage-through-one-module) — all verified still true as of this audit. No TypeScript, no
tests beyond one new unit-test file and one offline smoke script, no CI, no lint config.

## 2. Existing workflow

Upload → **manual** "Understand this photo" click (AI Understand tab) → **manual** "Generate N
schemes" click (AI Schemes tab) → manual Apply → manual Save as concept. Object removal
(`/clean`) is a separate manual action, not part of this chain at all. There is no automatic
trigger anywhere in the pipeline — every stage requires a dealer to click a button and wait
synchronously for the HTTP response. This is the exact gap Problem A in the brief describes.

## 3. Actual AI models (what really runs, verified by reading the executing code)

| Capability | Default today | Real model? |
|---|---|---|
| House understanding | `mock` (`AI_ANALYSIS_PROVIDER` unset in `backend/.env`) | **No** — `mockProvider.js` is deterministic Jimp heuristics (LAB/HSL band classification, connected components), self-labeled "Developer Mock." Fixed, non-learned confidences. |
| House understanding (available, inactive) | `http-vision` → `backend/vision-service/` (Python) | **Yes when running** — Grounding DINO (`grounding-dino-tiny`) + SAM2 (`sam2-hiera-tiny`) via `transformers`, local GPU inference. Not started by default; no automatic fallback if it's down. |
| House understanding (available, inactive, unverified live) | `hf-vision` (new this session) | **Partially verified** — same DINO+SAM2 chain via Hugging Face Inference Providers (cloud, needs `HF_API_KEY`). The geometric post-processing (`visionAssembly.js`) is unit-tested offline (17/17, `npm run smoke:vision`); the actual network calls to HF's detection/segmentation endpoints have **not** been exercised against a live response in this audit — the code's own comments flag the SAM2 box-prompt parameter names as varying by deployment. Treat as unverified until a live call succeeds. |
| Paint recommendation | `catalog` | **No, by design** — rule-based color theory (8 named templates) scored only against paints that exist in the catalog. This is correct behavior per the brief's own rule ("never invent colors"), not a placeholder to fix. |
| Object removal / cleanup | `huggingface` (per `.env`) or `clipdrop` | **Yes** — real external inpainting APIs, key-gated. Already fully external; not part of the house-understanding pipeline. |

**Bottom line:** exactly one real trained-model code path exists in the repo
(`backend/vision-service/pipeline.py`), and it is not the active default. What the UI currently
calls "AI analysis" is a rule engine. This must be represented honestly per Rule 34 — the
`isMockProvider` badge added this session (`AIAnalyzeTab.jsx`) is the current mechanism for that,
but it only covers the Understand tab, not Schemes.

## 4. Actual providers (registry contents)

`backend/src/services/ai/aiRegistry.service.js` → `PROVIDERS = [mockProvider, httpVisionProvider,
hfVisionProvider, catalogRecommendationProvider]`. Capability dispatch (`house-understanding` |
`paint-recommendation`) is config-selected via `AI_ANALYSIS_PROVIDER` / `AI_RECOMMENDATION_PROVIDER`
env vars, resolved once per request in `aiConfig.js`. This is a clean seam — every provider
implements `{id, version, supports(capability), run(capability, input) → {output, confidence,
modelVersion}}` — and is the correct extension point for Phase 2+ work; it should not be
duplicated or forked.

## 5. Existing state machine

**There isn't a unified one.** Three independent operations, each with its own status field, and
none of them coordinate with each other:

- `assets.status`: `uploaded → cleaning → cleaned | failed` (object removal only).
- `ai_jobs.status`: `running → succeeded | failed`, one row per analysis **or** per
  recommendation run (`job_type` distinguishes them), keyed to `asset_id`. No "stage" concept
  inside a job — a job is atomic (one provider call in, one result out).
- `paint_recommendations.status`: `draft | applied`, per scheme, not per pipeline run.

Nothing tracks "where is this asset in the overall AI pipeline" as a single value. The brief's
target lifecycle (`PROJECT_CREATED → … → AI_READY`) does not exist yet — Phase 2 needs to either
add a new orchestration-level status (e.g., on `assets`, or a new `ai_pipeline_runs` table) or
compose the existing three job types into a sequence, rather than inventing a second, competing
job system alongside `ai_jobs`. Given `ai_jobs` already has `job_type`, `provider`,
`model_version`, `status`, `processing_time_ms`, `failure_reason`, `output_json` — it is the
correct table to extend (new `job_type` values for object-detection/removal/segmentation stages,
or a `pipeline_stage` column) rather than replace.

## 6. Data flow

Photo bytes never leave the Node process during analysis (buffer in, buffer out); only
`/clean` and `hf-vision` send bytes to a third party. Masks are always files
(`uploads/<assetId>/ai/*.png`), never inline pixels in any API response or DB column — this is
consistent everywhere it was checked (`houseUnderstanding.service.js`, `mockProvider.js`,
`hfVisionProvider.js`, `renderSchemePreview.js`). See `DOCUMENTATION.md` §6.2 Flow A for the full
upload→understand→scheme→apply→save sequence with file:line references — verified still accurate.

## 7. API flow

No change since `DOCUMENTATION.md` §6.1 was written: `POST .../ai/analyze`, `GET .../ai/analysis`,
`POST .../ai/recommendations`, `GET .../ai/recommendations`, `GET /api/meta`. All synchronous —
the HTTP response only returns after the provider call completes, which is why Problem A exists
(nothing to poll; the button IS the wait). A future `POST .../ai/process` + `GET .../ai/status`
per the brief's §23 would sit alongside these, not replace them (`GET .../ai/analysis` and
`.../recommendations` stay as read endpoints for whatever the orchestrator produced).

## 8. Rendering flow

Single renderer confirmed: `colorEngine.applyPaintColor` (RGB→LAB blend preserving source
lightness/shading) is called from exactly three places — `LayerNode` (live canvas),
`renderSchemePreview.js` (scheme cards), `ExportPanel` (export) — and only from those three. This
session's crash fix did not add a second render path; it fixed a compositing bug in the preview
path (`putImageData` overwrite → per-surface layer canvas + `drawImage`) and bounded its
resolution. The brief's Phase 6 ask ("preserve lighting/shadows/texture, not a transparent
overlay") is **already satisfied** by the existing `lightnessBlend` mechanism — this is not a gap,
contrary to how the brief's Section 12 reads if taken as describing this codebase specifically.

## 9. Broken areas (current, verified)

- **Fixed this session, previously broken:** AI Schemes render-time OOM/freeze (`RecommendationsTab.jsx`
  crash, full incident reports in `AI_SCHEMES_CRASH_INCIDENT.md` / `AI_SCHEMES_ACTIVATION_CRASH_FORENSIC.md`).
- **Still broken / open, per `DOCUMENTATION.md` §9.2–9.3:** Excel import transaction doesn't
  actually wrap writes (P0 correctness); `/files/*` serves all photos/masks with no auth (P0
  security); access-key middleware fails open when unset (P1); optimistic-concurrency `updatedAt`
  checks exist server-side but no UI caller sends them, so the conflict toast is unreachable (P2).
  None of these were touched this session.
- **New, unverified:** `hf-vision` provider's live HTTP behavior (see §3).

## 10. Duplicate logic

None found. The registry pattern (§4) and the single-renderer invariant (§8) are specifically
what prevent duplication, and both held up under this audit — `hfVisionProvider.js` reuses
`visionAssembly.js` rather than re-implementing the surface/trim/gutter derivation logic that
already exists in `mockProvider.js` and (as Python) `vision-service/pipeline.py`. That said, the
same geometric post-processing now has **three independent implementations** (Python
`pipeline.py`, JS `mockProvider.js` inline, JS `visionAssembly.js`) that must be kept in sync by
hand if the surface/role rules ever change — worth consolidating if `hf-vision` becomes the
long-term default, but not a duplication bug today (each serves a different provider and none
call each other incorrectly).

## 11. Placeholder logic

Covered exhaustively in `DOCUMENTATION.md` §9.4 / §11 (mock provider, PDF export 501, auth
absent by design, dead `activeColor` UI chain, etc.) — re-verified spot checks (mock provider
still the live default, PDF route still 501) match. Nothing new introduced this session is a
placeholder: the crash-fix code, async storage, and timeout/badge changes are all real,
finished logic with passing tests, not stubs.

## 12. Production risks (new/changed since 2026-08-05)

1. **`hf-vision` is untested against a live endpoint.** Shipping it as the active provider
   without a real smoke test would violate Rule 34 (no fake AI) the same way `mock` mislabeled
   as "AI" would — the difference is `mock` is honestly badged, `hf-vision` currently is not
   (the badge only fires for `provider === 'mock'`).
2. **Provider drift risk on state reset.** The active provider silently reverted from
   `http-vision` (memory: was configured 2026-08-06) back to `mock` (unset in current `.env`) —
   `.env` isn't version-controlled by design, so this kind of silent regression has no audit
   trail. If Phase 2+ work assumes a real provider is active, verify `AI_ANALYSIS_PROVIDER`
   before trusting analysis output quality.
3. Everything already listed as P0/P1 in `DOCUMENTATION.md` §9.3 (live HF key at rest, open
   `/files/*`, fail-open access key) remains outstanding and unaffected by this session's changes.

## 13. Recommended implementation order

Defer to the brief's own Phase 1–17 order (Section 32) — codebase evidence does not contradict
it. Concretely, next up after this audit:

- **Phase 1 gate is already satisfied** — see verdict below. No further Phase 1 work needed
  unless new regressions appear.
- **Phase 2** (autonomous pipeline) is the first phase requiring real design decisions before
  any code: what triggers the pipeline (upload success handler vs. a separate "start processing"
  call the frontend fires immediately after upload), how progress is surfaced (poll `ai_jobs` vs.
  a new status endpoint vs. SSE), and whether object-removal becomes a mandatory pipeline stage
  or stays the separate manual `/clean` action it is today (the brief's lifecycle assumes the
  former; the current product treats cleanup as optional/manual). These are product calls, not
  audit findings — flagging for explicit decision before implementation starts.

---

## Phase gate verdicts (as of this audit)

| Gate | Verdict | Evidence |
|---|---|---|
| **Phase 1** — RecommendationsTab has no "Maximum update depth exceeded" | ✅ **Satisfied.** Root cause (render-time `toDataURL` + concurrent full-res `Promise.all`) fixed and committed (`a2d1be6`). Not actually an infinite-loop bug (confirmed by the forensic report's §13) — it was an OOM/freeze, now bounded. 7/7 new unit tests pass. | `RecommendationsTab.jsx`, `schemePreviewCore.js`, `schemePreviewCore.test.js` |
| **Phase 2** — Upload automatically starts AI processing | ❌ **Not satisfied.** Confirmed manual-trigger-only (§2). Not started this session. | `AIAnalyzeTab.jsx:runAnalysis` still the only trigger |
| **Phase 3** — House understood without user interaction | ❌ **Not satisfied** (depends on Phase 2) — understanding itself works, but requires a click. | — |
| **Phase 4** — Object removal is house-aware, integrated into the pipeline | ❌ **Not satisfied.** `/clean` is a separate, manual, non-house-aware action (masks whatever the user brushes or nothing) — not wired to house-understanding output at all today. | `assets.controller.js:requestCleanup` |
| **Phase 5** — Surfaces pass quality validation, not just "model returned a mask" | ❌ **Not satisfied.** No validation layer exists; confidences are accepted as-is (and for `mock`, are fixed constants, not model output — see `DOCUMENTATION.md` §9.4). | `mockProvider.js`, `houseUnderstanding.service.js` |
| **Phase 6** — Color application preserves lighting/texture | ✅ **Already satisfied**, pre-existing (`colorEngine.js` lightness-blend), reconfirmed working through the preview-path fix this session. | `colorEngine.js:118-181` |
| **Phase 8** — Recommendations are semantically coherent | ⚠️ **Partial.** Rule-based scoring against real catalog paints (not random), 8 named templates with real hue/lightness relationships — but no visual/rendered validation gate before a scheme is shown (a scheme is "valid" once it type-checks, not once it's confirmed to look coherent on this specific house). | `catalogRecommendationProvider.js` |
| **Phase 9** — Every scheme renders against the actual house | ✅ **Satisfied**, and specifically hardened this session (preview compositing bug fixed, so previews now actually match what Apply would produce). | `renderSchemePreview.js` |
