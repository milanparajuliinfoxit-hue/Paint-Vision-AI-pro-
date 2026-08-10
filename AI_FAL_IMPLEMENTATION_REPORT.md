# AI Fal.ai Implementation Report

**Date:** 2026-08-10
**Status:** IMPLEMENTED, CONTRACT-TESTED. NOT YET LIVE-VALIDATED (`FAL_API_KEY` not available).

---

## 1. Executive Summary

Replicate's house-understanding provider remains blocked on account billing (402 insufficient credit) after repeated real attempts. Rather than continue waiting, a second, independently-selectable `house-understanding` provider was implemented on **fal.ai**, using Meta's **SAM 3** (officially hosted at `fal-ai/sam-3/image`). This is architecturally simpler than the Replicate pipeline it sits alongside — one model, one call per semantic class, no detector-to-segmenter box handoff — and every input/output field used was confirmed from fal's own documentation and JS client source, not guessed. `replicate-vision` was **not removed**; both providers are registered, and `AI_ANALYSIS_PROVIDER` selects which is active. `fal-vision` is now the active default while Replicate billing is unresolved.

The existing downstream architecture (surface registry, AI→layer upsert, catalog-constrained schemes, cleanup-mask connector, pipeline idempotency, dealer workspace) required **zero changes** — it was already provider-agnostic, and this is the second real proof of that (the first being `replicate-vision` itself).

**Real-image validation could not be performed this session** — a `FAL_API_KEY` was never provided. Everything reported below is IMPLEMENTED and TESTED WITH MOCK (HTTP boundary mocked at fal.ai's real, confirmed contract) — never blurred with "the AI works."

---

## 2. Provider Decision

**fal.ai**, chosen because:
- Officially hosts SAM 3 (`fal-ai/sam-3/image`) — Meta's real Nov-2025 release, not a community wrapper (the situation that ruled out SAM 3 on Replicate during the original provider evaluation).
- Single-call, open-vocabulary, concept-based text→mask segmentation — no second model needed.
- REST contract fully confirmed from fal's own JS client source and auth docs (see AI_HOSTED_ARCHITECTURE.md §9) — the queue submit/poll/result lifecycle is evidence-based, not assumed.

---

## 3. Model Decision

**`fal-ai/sam-3/image`** over `fal-ai/evf-sam` (EVF-SAM2) and over porting Grounding DINO+SAM2 to fal.ai — SAM 3's output includes per-instance scores and boxes alongside masks, which this app's per-class confidence-threshold + union-of-instances design needs; EVF-SAM's documented output is a single mask image with no scores. Full comparison table in AI_HOSTED_ARCHITECTURE.md §9.

---

## 4. Architecture

```
Uploaded photo
      │
      ▼
falVisionProvider.js ── one fal-ai/sam-3/image call per class in PROMPT_CLASSES
      │                  (roof, wall, window, door, tree, car, person, fence, sky, ground)
      ▼
per-class {mask, confidence, source} ── same shape replicateVisionProvider.js produces
      │
      ▼
houseSceneNormalizer.js ── buildAnalysis() — shared, provider-independent geometry
      │                     (roof clamp, wall-minus-openings, trim/gutter, banding)
      ▼
houseUnderstanding.service.js ── UNCHANGED — persists to detected_surfaces/detected_objects,
      │                           saves mask files, scores surface quality
      ▼
existing surface registry / AI-layer upsert / cleanup-mask connector / catalog schemes
      (all UNCHANGED — already provider-agnostic)
```

`aiRegistry.service.js` now resolves `AI_ANALYSIS_PROVIDER=fal-vision` to `falVisionProvider.js`; `replicate-vision` stays registered alongside it.

---

## 5. Files Changed

| File | Change | Reason |
|---|---|---|
| `backend/src/services/ai/houseSceneNormalizer.js` | **New.** `buildAnalysis()` + shared vocabulary (`PROMPT_CLASSES`/`CLASS_THRESHOLDS`/`SURFACE_META`/`OBJECT_META`) + mask combinators, extracted from `replicateVisionProvider.js` | fal-vision became a second real consumer of the exact same geometry — extracting it prevents the two providers' post-processing from silently drifting apart |
| `backend/src/services/ai/providers/replicateVisionProvider.js` | Refactored to import from `houseSceneNormalizer.js` instead of defining its own copy | Removes ~200 lines of now-duplicated logic; behavior unchanged (verified by its existing, unmodified test suite still passing) |
| `backend/src/services/providers/falClient.js` | **New.** fal.ai queue submit/poll/result client | Mirrors `replicateClient.js`'s structure for one consistent HTTP story across providers |
| `backend/src/services/ai/providers/falVisionProvider.js` | **New.** The `fal-vision` provider itself | Implements `house-understanding` against SAM 3 |
| `backend/src/services/ai/aiRegistry.service.js` | Registered `falVisionProvider` alongside the existing three | One-line addition to the `PROVIDERS` array, per the existing convention |
| `backend/.env` / `.env.example` | Added `FAL_*` config; switched `AI_ANALYSIS_PROVIDER` default to `fal-vision`; kept all `REPLICATE_*` config intact | Config-only provider switch, reversible by changing one env var |
| `backend/src/services/providers/falClient.test.js` | **New** (5 tests) | Queue lifecycle contract, mocked HTTP |
| `backend/src/services/ai/providers/falVisionProvider.test.js` | **New** (4 tests) | Pure-logic: box denormalization, rasterization, missing-key stage tagging |
| `backend/src/services/ai/houseUnderstanding.falVision.contract.test.js` | **New** (1 test) | Full pipeline, HTTP mocked at fal's real confirmed contract, real DB/file assertions |

---

## 6. Configuration Changes

```env
AI_ANALYSIS_PROVIDER=fal-vision        # was replicate-vision
FAL_API_KEY=                           # blank — real key not yet available
FAL_SAM3_MODEL=fal-ai/sam-3/image
FAL_MAX_MASKS_PER_CLASS=3
AI_FAL_POLL_INTERVAL_MS=1500
AI_FAL_POLL_TIMEOUT_MS=45000
```
`REPLICATE_*` config is untouched and still present — switching back is a one-line env change, no code change.

**Security verified:** `FAL_API_KEY` blank in both `.env` (gitignored, confirmed via `git check-ignore`) and `.env.example` (placeholder only). Grepped the tracked working tree for any literal key value — none found. Never logged (httpClient.js's structured logging emits provider/model/status/latency only).

---

## 7. API Contract

See AI_HOSTED_ARCHITECTURE.md §9 for the full confirmed request/response shapes (submit/status/result, and SAM-3's own input/output schema). Not reproduced twice here.

---

## 8. Detection Strategy

One `fal-ai/sam-3/image` call per class in `PROMPT_CLASSES` (`prompt: <class>`), `return_multiple_masks: true, max_masks: 3, include_scores: true, include_boxes: true`. Per-class confidence floor (`CLASS_THRESHOLDS`, shared with `replicate-vision`) filters returned instances before they're unioned into that class's mask.

---

## 9. Surface Strategy

Unchanged from `replicate-vision` — same `houseSceneNormalizer.buildAnalysis()` produces `front-wall`/`left-wall`/`right-wall`/`roof`/`trim`/`gutter`/`door`/`windows`, with `windows` correctly non-paintable per the existing convention.

---

## 10. Object/Removal Strategy

Unchanged — `tree`/`car`/`person`/`fence` become removable objects; `objectRemovalMask.service.js` consumes them with zero modification (verified directly in the contract test: a real removal mask was built from a fal-vision-detected tree).

---

## 11. Mask Processing

Each surviving class instance's mask image is downloaded and unioned (OR) into one boolean mask via `unionMaskUrls()` — same alpha/luminance-threshold decode `replicateVisionProvider.js`'s `parseSamOutput()` uses. If mask download fails, degrades to a rasterized-box fallback from SAM-3's own returned boxes (same "visible degradation, never a silent fake mask" rule as before).

---

## 12. Database Interaction

**None required.** `detected_surfaces`/`detected_objects`/`ai_jobs` already store provider/model/confidence generically — `fal-vision` writes through the exact same `houseUnderstanding.service.js` persistence code `replicate-vision` uses.

---

## 13. AI-Layer Integration

Unchanged and unverified-by-necessity — `upsertAiLayer`/`useApplySurface.js` consume `detected_surfaces` rows regardless of which provider produced them. Already proven generic by the Replicate contract test; not re-proven here to avoid redundant work, per the "don't repeat validated integration work" principle.

---

## 14. Real-Image Test

**NOT PERFORMED.** `FAL_API_KEY` was not provided this session. This is a missing-credential blocker, structurally identical to Replicate's original blocker before a token existed — not a billing rejection (fal.ai was never actually called with a real key to know whether it would even require payment upfront).

---

## 15–19. Detection Results / Mask-Quality Results / Latency / Failures / Cost Observations

**Not available** — no live call has been made. Reporting fabricated numbers here would violate this project's own "no claims without evidence" rule. These sections are intentionally left as: **BLOCKED — pending `FAL_API_KEY`.**

---

## 20. Test Results

- Backend: **128/128** (118 baseline + 10 new: 5 `falClient.test.js`, 4 `falVisionProvider.test.js`, 1 `houseUnderstanding.falVision.contract.test.js`)
- Frontend: **41/41**
- Build: **PASS**
- Server boot: confirmed — `aiRegistry.getProviderFor('house-understanding').id === 'fal-vision'`

All contract/unit tests use HTTP mocked at fal.ai's real, source-confirmed contract — labeled TESTED WITH MOCK, not VALIDATED ON REAL IMAGE.

---

## 21. Remaining Limitations

- **No live fal.ai call has ever succeeded or failed** — the entire quality picture (Gates B–J from the governing brief) is unknown until `FAL_API_KEY` is available.
- One unverified assumption carried into this implementation: whether `image_url` accepts a `data:` URI directly (see AI_HOSTED_ARCHITECTURE.md §9) — flagged for the first live call.
- `replicate-vision`'s own unverified assumption (SAM2's `input_boxes` field name) remains unresolved too, since it's also still blocked (billing, not superseded by this work).
- No cost/latency data exists for `fal-vision` yet.

---

## 22. Next Implementation Phase

1. Obtain a `FAL_API_KEY` (https://fal.ai/dashboard/keys) — this is the single blocking action.
2. Run one real end-to-end call against a real house photo (same script pattern already used for Replicate), record the P0 checklist (detections, masks, latency, confidence) in `AI_HOSTED_VALIDATION_REPORT.md`.
3. Visually inspect the returned masks per AI_HOSTED_VALIDATION_REPORT.md's quality table — house isolation, wall separation, roof/parapet, unwanted objects.
4. Resolve the `image_url` data-URI assumption based on that call's actual result (succeed as-is, or implement a fal storage-upload fallback if it 4xxs on the assumption specifically).
5. Only after real quality is inspected: decide whether `fal-vision` or `replicate-vision` (once its own billing is resolved) becomes the long-term default — objectively, per real output, not by default preference.
