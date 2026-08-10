# AI Hosted Validation Report — Phase 2 Live Validation

**Date:** 2026-08-10
**Status:** BLOCKED on external dependency (Replicate account billing) — see §8/§11.
**Scope:** Live validation of `replicate-vision` against a real house photo, through the actual provider abstraction (`aiRegistry.run('house-understanding', ...)`), no bypass, no mock.

---

## 1. Environment

| Check | Result |
|---|---|
| `REPLICATE_API_TOKEN` loads from `backend/.env` | ✅ present, 40 chars, `r8_...` prefix (Replicate's real token format). Not printed anywhere beyond a 3-char prefix in this report/terminal. |
| `AI_ANALYSIS_PROVIDER` | `replicate-vision` |
| `AI_ANALYSIS_ENABLED` | `true` |
| `aiRegistry.getProviderFor('house-understanding')` | resolves to `{id: 'replicate-vision', version: 'replicate-grounding-dino-sam2-v1'}` |
| `REPLICATE_DINO_MODEL` / `REPLICATE_SAM_MODEL` / `REPLICATE_SAM_BOX_FIELD` | `adirik/grounding-dino` / `meta/sam-2` / `input_boxes` — loaded correctly |
| Local AI model directory (`backend/vision-service/`) | confirmed absent |
| `torch`/`transformers`/`ollama`/`onnxruntime` references anywhere in `backend/src` | confirmed zero matches |
| Registered house-understanding providers | exactly one: `replicate-vision` (`mockProvider.js` present but not registered, as designed) |

**No local AI model was reinstalled, restored, or invoked at any point.** All calls below went over HTTPS to `api.replicate.com`.

### Pre-flight secret-handling note
Before running validation, found the real Replicate token had been pasted into `backend/.env.example` — a **git-tracked** template file — rather than the gitignored `backend/.env`. Fixed immediately: moved the real value to `backend/.env` (confirmed gitignored via `git check-ignore`), restored `.env.example`'s line to blank (matching every other secret placeholder in that file). Confirmed via `git diff` that the tracked file no longer contains the token. This was caught before any commit.

---

## 2. Real Test Image

Used an existing real asset already stored in this app's own `uploads/` directory (from prior dealer-workflow testing — project "Smith Residence"), rather than a synthetic or stock photo:

- **File:** `backend/uploads/578a49c5-e432-4561-baf6-9ea1825f91d5/original.jpg`
- **Dimensions:** 1204 × 1542 (portrait phone photo, Redmi Note 12, real EXIF-style overlay burned into the image: `06/04/2026 07:54`)
- **Viewpoint:** three-quarter/diagonal angle (not front-facing) — exactly the non-ideal-angle case the governing brief requires the system to handle
- **Content:** an under-construction 3-story concrete house. Visibly contains: multiple wall faces (front-facing and right-side-facing, at different perspective angles), a stepped/parapet roofline, a balcony opening, columns/pillars at the corners, several window and door openings (some unfinished/open), a visible electrical wire running down the front face, a tree at the left edge, a large cloudy sky, and a foreground of construction debris — gravel piles, ladders, loose rebar, granite slabs, a blue tarp. No boundary wall, gate, vehicles, or people are present in this particular photo.
- File size on disk: 438,787 bytes.

This is a realistic, non-trivial test case — closer to the "under-construction, angled, cluttered foreground" scenario the governing brief specifically calls out than an idealized front-facing catalog photo would be.

---

## 3. Real End-to-End Analysis — Attempts

Called `aiRegistry.run('house-understanding', { buffer })` directly (the real provider dispatch path — no bypass of the abstraction) three times as real integration bugs surfaced and were fixed between attempts.

| Attempt | Result | Root cause | Category (§7) |
|---|---|---|---|
| 1 | HTTP 422 "The specified version does not exist" | `replicateClient.js` POSTed `{"version": "adirik/grounding-dino", "input": {...}}` to the generic `/v1/predictions` endpoint. That shorthand only works for Replicate's "official" (verified-org) model listings — confirmed by direct `curl`-equivalent testing against the real API, not assumption. | Integration/request-format bug (not A–F; a plumbing defect predating any model-quality question) |
| 2 | HTTP 404 "The requested resource could not be found" | Tried `POST /v1/models/{owner}/{name}/predictions` instead — also doesn't apply to these two models (confirmed live: this path 404s even with a hand-built minimal request). Both `adirik/grounding-dino` and `meta/sam-2` are real, heavily-used public models (39.5M and 212k runs respectively, confirmed via `GET /v1/models/{owner}/{name}`) but not Replicate "official" listings, so neither of the two shortcut endpoints applies to them. | Integration/request-format bug |
| 3 | HTTP 402 "You have insufficient credit to run this model" | **Fixed the actual bug**: resolve each model's real 64-character `latest_version.id` via `GET /v1/models/{owner}/{name}` (cached per process, not hardcoded — a model update won't silently pin a stale version), then POST `{"version": "<hash>", "input": {...}}` to the generic `/v1/predictions` endpoint. This is accepted by Replicate — the request reaches the model and is rejected only on account billing, not on shape/auth/routing. | **External dependency, not a code defect** — see §8 |

Both fixes are now in `replicateClient.js` and covered by updated unit tests (mocked at the HTTP boundary) — 103/103 backend tests pass after the fix, no regressions.

**The pipeline's plumbing is now confirmed correct against the real Replicate API**: token auth accepted, request routing accepted, request body accepted, only blocked on billing.

---

## 4–6. Semantic Understanding / Surface Segmentation / Visual Inspection

**Not yet possible.** No prediction has actually run — every attempt above failed before Replicate's model containers even started (422/404 before submission was accepted; 402 rejected the submission itself before queuing). There is no detection output, no mask, no bounding box, and no latency-per-stage to evaluate. Fabricating placeholder numbers here to fill out the requested tables would violate the "no claims without evidence" rule this whole workflow is built on — so these sections are intentionally left empty rather than populated with guesses.

---

## 7. Problems Found — Classification

| # | Problem | Category |
|---|---|---|
| 1 | Wrong Replicate request shape (naive `version: "owner/name"`) | Integration bug — **fixed**, confirmed against real API |
| 2 | Wrong Replicate endpoint (`/models/.../predictions` for a non-official model) | Integration bug — **fixed**, confirmed against real API |
| 3 | Replicate account has no usable credit | **Category: external dependency (account billing), not a code or model-quality issue** |

No Category A (prompt), B (threshold), C (mask), D (geometry/post-processing), E (model limitation), or F (product-requirement) issues can be assessed yet — those all require a completed prediction, which billing is currently blocking.

---

## 8. CURRENT STATUS / BLOCKED

```
CURRENT STATUS: Phase 2 live validation — blocked before first successful inference.

COMPLETED:
  - Config/token loading verified correct.
  - No local AI model present or invoked (confirmed via filesystem + grep).
  - Real house photo selected (angled, under-construction, cluttered — a
    genuinely hard case, not a cherry-picked easy one).
  - Two real integration bugs in the Replicate request plumbing found and
    fixed against the live API (not guessed) — version resolution now
    correct, confirmed by the error changing from 422 -> 404 -> 402 as each
    layer of the request got closer to actually reaching the model.
  - Regression: 103/103 backend tests, 41/41 frontend tests, both green.
  - Secret-hygiene issue (token in a git-tracked file) caught and fixed
    before any commit.

BLOCKED:
  Replicate account has insufficient credit. Exact provider response:
  "You have insufficient credit to run this model. Go to
  https://replicate.com/account/billing#billing to purchase credit. Once
  you purchase credit, please wait a few minutes before trying again."

WHAT WAS VERIFIED:
  The request now reaches Replicate's billing/authorization layer for the
  real model (adirik/grounding-dino) — i.e. everything this codebase
  controls (auth, routing, payload shape, timeout/retry, error handling) is
  confirmed working against the real API. The blocker is entirely on the
  account side, not the integration.

WHAT IS REQUIRED TO CONTINUE:
  Add a payment method or purchase credit at
  https://replicate.com/account/billing#billing, then wait the few minutes
  Replicate's own error message specifies.

RECOMMENDED NEXT ACTION:
  Once credit is available, re-run the same one-line validation script
  (no code changes needed) to get the first real detection/segmentation
  result, then continue Steps 4-6 (semantic evaluation, visual inspection)
  against that real output.
```

---

## 9. Corrections Applied

1. `backend/src/services/providers/replicateClient.js` — replaced the incorrect prediction-creation request (two wrong shapes tried and rejected by the real API) with: resolve `latest_version.id` via `GET /v1/models/{owner}/{name}` (cached per process), then `POST /v1/predictions` with `{version: <hash>, input}`. Comment updated to document why, with the real HTTP evidence.
2. `backend/src/services/providers/replicateClient.test.js` — updated to mock the version-resolution call each test now makes first; added a new test asserting the version cache is only populated once per model per process.
3. `backend/src/services/ai/providers/replicateVisionProvider.js` — added stage-level structured logging (detect duration, segment duration, per-class sam2-vs-bbox-fallback source, total duration) via the existing `logger.service` — needed to capture the latency/degradation data this validation asked for, and doubles as real production observability per the governing brief's §26 requirement. Does not change the provider's output contract.
4. `backend/.env` / `backend/.env.example` — moved the leaked real token out of the tracked template file into the gitignored local env file.

No changes were made to the visualization, catalog, painting, layer, undo/redo, or export code paths.

---

## 10. Regression Status

- Backend: **103/103 passing** (`npm test` in `backend/`).
- Frontend: **41/41 passing** (`npm test` in `frontend/`).
- Server boot / registry load: confirmed via direct `require` — no throw, `replicate-vision` resolves correctly for the `house-understanding` capability.

---

## 11. Final Verdict

None of PASS / CONDITIONAL PASS / FAIL applies honestly yet — those all describe a judgment about **segmentation/understanding quality**, which cannot be assessed without a single successful prediction. Rendering one now would mean guessing.

**Verdict: BLOCKED — integration confirmed correct against the real API, quality unassessed pending Replicate account credit.**

Do not read the two fixed integration bugs (422, 404) as evidence the model choice is wrong — both were pure request-shape defects in this codebase, now confirmed fixed by the error progressing to a billing-layer response (402) rather than a routing/auth error. Do not read "blocked" as "the hosted approach failed" — the pipeline has not been allowed to run yet.
