# AI Hosted Architecture — House Understanding (Phase 1)

**Date:** 2026-08-10
**Scope:** Design only. No provider-specific code in this phase.
**Constraint:** hosted inference only — no local models, no local Python inference server (per governing brief §1.1).

---

## 1. What already exists and will NOT change

The provider-plugin architecture this app uses was already built for exactly this kind of swap and needs no rework:

```
houseUnderstanding.service.js  (orchestration: job row, storage, surface-quality scoring)
        ↓ calls
aiRegistry.service.js          (capability → provider lookup, wraps result in aiResult envelope)
        ↓ calls
providers/<id>.js              (provider-specific: HTTP calls, response parsing)
```

- `aiResult.js`'s envelope (`{ ok, output, confidence, processingTimeMs, modelVersion, provider, failureReason }`) is already the vendor-neutral contract every capability returns — routes/controllers/frontend never see a raw provider response today, and won't after this change either.
- The **normalized analysis shape** the rest of the app consumes already exists and is already fully defined by two independent things that both currently produce it: `mockProvider.js` (test-only) and the deleted `pipeline.py` (git history, recovered below). `houseUnderstanding.service.js` (lines 61, 82-118) reads exactly this shape:

```text
{
  scale:    { width, height, factor }
  house:    { present, bbox:{x,y,w,h}, confidence, style, material, color:{r,g,b} }
  context:  { skyColor, groundColor, roofColor, wallColor, lighting, palette:[{r,g,b}] }
  surfaces: [{ key, className, displayName, paintable, role, confidence,
               mask:{width,height,alpha:Uint8[0-255]}, geometry:{bbox,areaPx,areaRatio},
               averageColor:{r,g,b}, properties:{} }]
  objects:  [{ key, className, displayName, paintable:false, confidence,
               mask:{width,height,alpha}, geometry:{bbox,areaPx,areaRatio} }]
}
```

- `detected_surfaces` / `detected_objects` / `ai_jobs` (schema.sql:181-249, aiJobs.model.js) already store exactly this — one row per surface/object, mask saved to disk via `storage.service`, `ai_jobs.model_version`/`provider`/`confidence`/`processing_time_ms` already carry provider metadata. **No schema change. No migration.**

**Conclusion:** this is a pure provider-plugin addition. New file: `providers/replicateVisionProvider.js`. One registry line. One env var. Everything above this line in the stack is already correct and stays untouched — satisfies the governing rule against forking orchestration logic.

---

## 2. Recovered logic from the deleted local pipeline

`backend/vision-service/pipeline.py` and `server.py` were deleted in commit `8c2c675` (already merged, intentional — the local GPU model is not being restored). Recovered via `git show 8c2c675^:backend/vision-service/pipeline.py`.

### Reusable (ported to Node, provider-independent — pure geometry/heuristics, no model calls)

| Logic | What it does | Why it's still correct |
|---|---|---|
| `PROMPT_CLASSES` / `TEXT_PROMPT` | `roof. wall. window. door. tree. car. person. fence. sky. ground.` | Vocabulary is a text prompt, not tied to the local model |
| `CLASS_THRESHOLDS` | Per-class confidence floor (wall 0.15, door 0.25, window/tree/car/person/fence 0.30, roof 0.20) | Empirically tuned against real house photos — walls score much lower than compact objects on *any* open-vocab detector, not a quirk of the local model specifically |
| Ambiguous-phrase rejection | Discards a detection if its label substring-matches more than one prompt class (e.g. "roof sky") | Guards against a box spanning two concepts; generic to any Grounding-DINO-family output |
| Roof geometric clamp | Roof mask clipped to top 45% of the house bbox | Guards against a detector boxing the whole building as "roof" on flat/under-construction roofs |
| Trim/gutter derivation | Dilate wall mask by 3px, dilate window mask by 2px → trim; thin band under roof bottom → gutter | These were never detected directly even locally — always geometric. Still correct. |
| Left/right wall banding | Outer 10% of house bbox width → accent walls; middle → front wall | Same convention as the (still-live) `mockProvider.js` |
| Wall/roof/sky/ground color, style/material guess | Dominant/median color sampling + HSL heuristics | Pure pixel math, unrelated to which model produced the masks |

All of the above are already implemented a second time, independently, in JS in `mockProvider.js` (`dilate`, `connectedComponents`, `fillComp`, `toAlpha255`, `dominantColor`, `medianColor`, `dominantPalette`, `guessStyle`, `guessMaterial` — lines 450-577). Rather than re-port the Python a third time, **Phase 2 extracts those exact functions out of `mockProvider.js` into a new shared `backend/src/services/ai/maskGeometry.js`**, imported by both the untouched mock (test-only fixture) and the new real provider. This is lifting duplicated logic into one place, not rewriting either caller.

### NOT reusable (tied to local inference — correctly deleted, will not be restored)

`_load_models`, `DEVICE = cuda/cpu`, `torch.inference_mode`, `AutoProcessor.from_pretrained`, `Sam2Model` — all local-weights/local-GPU specific. These are replaced by two HTTP calls to hosted Replicate endpoints (§3).

---

## 3. Hosted model selection

### Evaluated

| Candidate | Call shape | Evidence | Verdict |
|---|---|---|---|
| **`adirik/grounding-dino`** (Replicate) | 1 call: image + comma-separated text query → boxes+labels+scores | Confirmed from source (`replicate/cog-grounding-dino/predict.py`, official Replicate-org repo): `Input{image, query, box_threshold=0.25, text_threshold=0.25}` → `Output{detections:[{label,confidence,bbox:[x0,y0,x1,y1]}], result_image?}`. ~$0.001/run, ~1s (Replicate's own pricing page). | **Selected** for detection stage — same model family as the already-proven local pipeline, schema confirmed from source, cheap, fast, official repo. |
| **`meta/sam-2`** (Replicate, official) | Box/point-promptable segmentation | Pricing confirmed (~$0.012-0.019/run, ~13-20s, L40S GPU). Exact box-prompt input field names could **not** be confirmed from source — Replicate's model page is client-rendered (schema not in static HTML) and the one community cog wrapper found (`lucataco/cog-segment-anything-2`) turned out to be automatic-grid-sampling only, **no box-prompt input at all** — not representative of what `meta/sam-2`'s official listing actually exposes. | **Selected conditionally** for the mask-refinement stage — see §5 "unverified assumption" and the fallback it's given. |
| `schananas/grounded_sam` (single-call text→mask) | 1 call, text prompt directly to mask | Exists and would collapse detection+segmentation into one HTTP round-trip. But its documented purpose is clothing segmentation for virtual try-on ("main component of doiwear.it") — no evidence it generalizes to architectural classes. | Rejected — wrong domain, unverified for this use case. |
| `mattsays/sam3-image` / `lucataco/sam3-video` (SAM 3 community wrappers) | 1 call, native text-prompted segmentation, no separate detector needed | SAM 3 (Meta, released Nov 2025) genuinely does open-vocabulary text→mask in one model, which would be architecturally simpler than the two-stage DINO+SAM2 pipeline. But there is **no official `meta/sam-3`** listing on Replicate yet — only third-party wrappers, unverified maintenance/reliability track record. | Rejected **for now** on production-stability grounds (governing brief's own evaluation criterion). Worth revisiting once an official listing exists or a community wrapper accumulates a longer track record — noted as a future upgrade path, not a Phase 2 blocker. |

### Selected pipeline

```
photo (downscaled to AI_ANALYSIS_MAX_DIM=640, same knob the mock provider already uses)
   ↓
adirik/grounding-dino  — text query "roof. wall. window. door. tree. car. person. fence. sky. ground."
   ↓ boxes + labels + scores
per-class threshold filter + ambiguous-phrase rejection  (ported from pipeline.py)
   ↓ boxes, one set per class
meta/sam-2  — box-prompted segmentation, one call per class's box set
   ↓ pixel masks
roof clamp / trim-gutter derivation / wall banding / color extraction  (ported, §2)
   ↓
normalized HouseAnalysis (§1's existing shape — no new schema)
```

Two Replicate calls per class-with-detections, not one call per photo — cost estimate below accounts for this.

---

## 4. Provider adapter design

**New file:** `backend/src/services/ai/providers/replicateVisionProvider.js`
**Registry id:** `replicate-vision`
**Capability:** `house-understanding` only

```js
const ID = 'replicate-vision';
const VERSION = 'replicate-grounding-dino-sam2-v1';
function supports(capability) { return capability === 'house-understanding'; }
async function run(capability, input) { /* §3 pipeline; returns { output, confidence, modelVersion } */ }
module.exports = { id: ID, version: VERSION, supports, run };
```

Registered alongside the existing two in `aiRegistry.service.js`:
```js
const PROVIDERS = [catalogRecommendationProvider, hfSchemeProvider, replicateVisionProvider];
```
One line added, nothing removed, nothing reordered.

### Replicate REST usage (confirmed from Replicate's own HTTP API docs)

```
POST https://api.replicate.com/v1/predictions
  Authorization: Bearer <REPLICATE_API_TOKEN>
  Content-Type: application/json
  body: { "version": "adirik/grounding-dino", "input": {...} }
  → { id, status: starting|processing|succeeded|failed|canceled, output, error, urls:{get,cancel} }

GET  https://api.replicate.com/v1/predictions/{id}   — poll until status is terminal
```

Design decision: **always poll via `GET`, do not rely on `Prefer: wait`.** Replicate's synchronous wait caps at 60s; this pipeline is two chained model calls (detect, then per-class segment) that could plausibly exceed that on a slow cold-start, and an ambiguous timeout-vs-still-running state is worse than an explicit poll loop with a clear timeout error. Reuses `httpClient.post` for the initial POST (gets the existing timeout/retry/logging for free) plus a small poll loop using `fetchWithTimeout`-equivalent semantics, capped by a new `AI_REPLICATE_POLL_TIMEOUT_MS` (proposed default 45000, i.e. within the existing `AI_VISION_TIMEOUT_MS=60000` overall budget already used elsewhere for this capability).

### Config (env-driven, per governing brief §24)

```
AI_ANALYSIS_PROVIDER=replicate-vision
REPLICATE_API_TOKEN=              # required, never sent to frontend, never logged
REPLICATE_DINO_MODEL=adirik/grounding-dino
REPLICATE_SAM_MODEL=meta/sam-2
AI_ANALYSIS_MAX_DIM=640           # already exists, reused as-is
AI_VISION_TIMEOUT_MS=60000        # already exists, reused as the overall per-call budget
AI_REPLICATE_POLL_INTERVAL_MS=1500  # new
AI_REPLICATE_POLL_TIMEOUT_MS=45000  # new
```

No secret is ever exposed via `/api/meta` (checked: `meta.routes.js` currently only reports capability enabled/disabled + provider id, never the key — this stays true, nothing there changes).

### Error handling (maps to existing `ProviderError` / job-failure path, no new failure model)

| Failure | Handling |
|---|---|
| `REPLICATE_API_TOKEN` missing | `ProviderError` thrown before any network call — same pattern `hfSchemeProvider.js` uses for `HF_API_KEY` |
| 401/403 (bad token) | `ProviderError`, non-retriable — surfaces as job `failed`, generic message to client (existing error handler already strips detail) |
| 402 (insufficient credit) | `ProviderError`, non-retriable, distinct message so the dealer/admin knows it's a billing issue, not a bug |
| 429/5xx during POST | Already retried by `httpClient.post` (existing backoff, 2 retries) — no new code |
| Prediction `status: "failed"` | Treated as `ProviderError` with the prediction's own `error` field as detail |
| Poll loop exceeds `AI_REPLICATE_POLL_TIMEOUT_MS` | `ProviderError("timed out")`, and the adapter calls the prediction's `cancel` URL best-effort so an abandoned poll doesn't keep billing |
| SAM2 box-prompt schema mismatch (see §5) | Caught narrowly around just the SAM2 call; on failure, degrade to the Grounding DINO box itself as a rectangular mask for that one class, tag `properties.maskSource = "bbox-fallback"` — **never silently returns a full-image or empty mask**, and the degradation is visible in the data, not hidden |

This satisfies "never silently fall back to a fake AI result" — a bbox-shaped mask for one class when SAM2 disagrees with our schema guess is a visible, logged, lower-confidence degradation of *this run*, not a swap to a different (fake) provider.

---

## 5. Explicitly unverified — flagged for Phase 2's first live test, not assumed as fact

1. **`meta/sam-2`'s exact box-prompt input field names.** Replicate's own model page is JS-rendered and didn't expose the schema to automated fetch; the one GitHub cog source found for a SAM2 wrapper turned out to only support automatic full-image mask generation, not box prompts, so it's not a reliable stand-in for what the official `meta/sam-2` listing actually accepts. The adapter will be written against best-effort field names (`input_boxes`, mirroring the deleted local pipeline's own `sam_processor(images=image, input_boxes=[boxes])` call) but this is a guess, isolated to one small function, verified by the first real call once `REPLICATE_API_TOKEN` exists.
2. **Real end-to-end latency** for the two-stage pipeline on an actual house photo (target: 10-30s per the governing brief's performance section). Per-model figures suggest it fits (~1s + ~15-20s ≈ well under 30s), but only a live call proves it.
3. **Real segmentation quality** on the 12-photo evaluation set (angled, side-view, boundary wall, gate, etc. — governing brief §28/Phase 8). Nothing about model choice is validated by pricing pages; only real photos prove it.

None of these block writing the adapter code (Phase 2) — they block claiming it *works*, which is exactly the distinction the governing brief's evidence rule draws. Phase 2 will implement against this design; Phase 8 (or an early smoke test right after Phase 2, once the token exists) is where assumption #1 in particular gets confirmed or corrected.

---

## 6. Cost

Per photo, worst case (all 6 objects + roof + wall detected, i.e. up to ~9 classes with boxes):
- 1× `grounding-dino` call: ~$0.001
- up to 9× `sam-2` box-prompt calls (one per class with a detection, batched per-class not per-box where possible): ~$0.012–0.019 each → ~$0.11–0.17 worst case, realistically less since most houses don't trigger all 9 classes

**Estimated ~$0.03–0.10 per photo analysis**, no subscription. In-flight lock (`inFlightLock.service.js`, already exists) + the DB's `uq_ai_jobs_running` constraint (already exists) prevent duplicate concurrent billing for the same asset — reused as-is, no new cost-control code needed for Phase 1/2.

---

## 7. What Phase 1 explicitly does NOT do

- No database migration.
- No change to `houseUnderstanding.service.js`'s orchestration logic (it already speaks the right contract).
- No change to the cleanup/inpainting provider (existing hosted FLUX.2-edit path stays as-is; Phase 4 will feed it real masks instead of the heuristic default, not replace it).
- No frontend change.
- No change to `mockProvider.js` itself (stays test-only; only its geometry helpers get lifted into a shared module).

---

## 8. Phase 2 entry criteria

1. This document reviewed/approved.
2. `REPLICATE_API_TOKEN` available in `backend/.env` (user action, outstanding).
3. Phase 2 implements `replicateVisionProvider.js` + `maskGeometry.js` per this design, registers it, and runs **one real call** against a real house photo to confirm/correct §5's assumptions before claiming the capability works.

## 9. Phase 2 status (2026-08-10)

**Implemented, code-complete, no live token yet:**
- `backend/src/services/ai/maskGeometry.js` — shared geometry helpers (new module; `mockProvider.js` left untouched rather than refactored to import it, to keep this change's blast radius to the new code path only).
- `backend/src/services/providers/replicateClient.js` — generic Replicate create+poll prediction lifecycle.
- `backend/src/services/ai/providers/replicateVisionProvider.js` — the two-stage pipeline, ported post-processing, bbox-fallback degradation.
- Registered in `aiRegistry.service.js`; `backend/.env` / `.env.example` updated with all new config keys.
- 15 new unit tests (`maskGeometry.test.js`, `replicateVisionProvider.test.js`, `replicateClient.test.js` — the last with `global.fetch` mocked at the HTTP boundary per the governing brief's provider-contract testing requirement). Full suite: **102/102 backend, 41/41 frontend, all green.**
- Manually verified fail-closed behavior with no token set: `aiRegistry.run('house-understanding', ...)` returns `{ok:false, failureReason:"REPLICATE_API_TOKEN is missing..."}` — no crash, no fake result.

**Not yet done (blocked on `REPLICATE_API_TOKEN`):**
- The one live call that confirms or corrects §5's SAM2 box-prompt-field assumption.
- Real latency/quality measurement on an actual house photo (Phase 8 real-image evaluation).

---

## 9. Provider switch: fal.ai / SAM 3 (2026-08-10)

**Trigger:** Replicate remains blocked on account billing (402 insufficient credit) after multiple real attempts (see AI_HOSTED_VALIDATION_REPORT.md). Rather than continue waiting, added a second, independently-selectable `house-understanding` provider on fal.ai. `replicate-vision` is **not removed** — both are registered in `aiRegistry.service.js`; `AI_ANALYSIS_PROVIDER` picks which one is active.

### Model selection process (per this repo's own policy: research before choosing, evidence over popularity)

| Candidate | Call shape | Evidence | Verdict |
|---|---|---|---|
| **`fal-ai/sam-3/image`** (fal.ai, official) | 1 call **per class**: text `prompt` → masks + scores + boxes, directly | Input/output schema **confirmed from fal's own API reference** (`fal.ai/models/fal-ai/sam-3/image/api`) — not guessed. SAM 3 (Meta, Nov 2025) is a native open-vocabulary, concept-based text→mask model; no separate detector needed. | **Selected** |
| `fal-ai/evf-sam` (EVF-SAM2 on fal.ai) | 1 call, positive/negative text prompt → one mask image | Schema confirmed from fal's docs, but output has no scores/multi-instance support shown — weaker fit for "give me every instance of this class with a confidence I can threshold." | Rejected — SAM-3's richer output (scores, boxes, multiple masks) is a better match for this app's per-class confidence-threshold + union-of-instances pattern |
| Grounding DINO + SAM2 on fal.ai (porting the Replicate two-stage design as-is) | 2 calls per class (detect once, then segment) | Would have worked, but strictly more complex (two models, box handoff, a second unverified schema) than SAM-3's one-call design for no quality benefit evidenced yet | Rejected in favor of the simpler pipeline, per this doc's own §8/§31 guidance ("prefer the simpler pipeline if one model can do both jobs") |

### Why this is architecturally simpler than replicate-vision

Grounding DINO + SAM2 needed two stages (detect → box handoff → segment) because SAM2 has no text understanding of its own. SAM 3 fuses both — one call per class returns that class's instances as real pixel masks, scores, and boxes together. This eliminates:
- the box-format handoff between two different models (a real source of the SAM2 `input_boxes` field-name uncertainty that dogged `replicate-vision`)
- the "ambiguous merged-phrase" detection-side filtering `replicateVisionProvider.js` needs (not applicable — each fal call is already scoped to one concept)

The downstream geometry (roof clamp, wall-minus-openings, trim/gutter derivation, wall banding) is **identical** for both providers — extracted into `backend/src/services/ai/houseSceneNormalizer.js`, a shared module neither provider owns, so this logic can't drift between them.

### Confirmed contract (from source, not assumed)

```
POST https://queue.fal.run/{model}          body = raw model input (NOT {input:...})
  headers: Authorization: Key <FAL_API_KEY>, Content-Type: application/json
  -> {request_id, status, status_url, response_url, cancel_url, queue_position}

GET  {status_url}   -> {status: IN_QUEUE|IN_PROGRESS|COMPLETED|ERROR}
GET  {response_url} -> the model's own output JSON
PUT  {cancel_url}   -> best-effort cancel
```
Confirmed from fal's own JS client source (`github.com/fal-ai/fal-js`, `libs/client/src/queue.ts`) and `docs.fal.ai/reference/platform-apis/authentication` — both fetched and read directly, not inferred.

`fal-ai/sam-3/image` input/output (confirmed from `fal.ai/models/fal-ai/sam-3/image/api`):
```
input:  { image_url, prompt, point_prompts?, box_prompts?, return_multiple_masks?,
          max_masks?, output_format?, include_scores?, include_boxes? }
output: { image, masks: [{url,...}], metadata: [...], scores: [float],
          boxes: [[cx,cy,w,h] normalized 0..1] }
```

### One remaining unverified assumption

Whether `image_url` accepts a `data:` URI directly (assumed here, matching every other hosted model this app has integrated — Replicate's Grounding DINO/SAM2 both did) versus requiring a separate fal storage-upload step first. Flagged in `falVisionProvider.js`'s header for the first live call to confirm or correct — same treatment the SAM2 box-field assumption got before it, which is exactly how that one was eventually resolved (see AI_FAL_IMPLEMENTATION_REPORT.md).

### Cost / latency (from fal.ai's public pricing pages, not yet live-measured)

Per photo, up to 10 calls (one per PROMPT_CLASS). fal.ai's SAM-3 pricing was not itemized in this session's research; cost/latency will be recorded from the first real call once `FAL_API_KEY` exists, same as Replicate's numbers were.

### Status

**IMPLEMENTED, contract-tested** (HTTP mocked at the boundary — see `houseUnderstanding.falVision.contract.test.js`). **NOT YET tested against the real fal.ai API or a real image** — `FAL_API_KEY` is not yet available (see AI_FAL_IMPLEMENTATION_REPORT.md §14).
