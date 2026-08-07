# AI Local-Model Audit

**Date:** 2026-08-07
**Branch:** `feat/ai-house-understanding`
**Scope:** Every artifact in the repo that performs AI/image-model work (trained models, heuristic "AI" stand-ins, and the adapters that serve them), audited as the first phase of migrating local/browser AI to external hosted APIs.

---

## 1. Headline finding

There is exactly **one piece of real trained-model code in the repository**:

- `backend/vision-service/` — a local Python **Grounded-SAM2** (Grounding DINO + SAM2) HTTP vision service. It is **not the default**, is **not dockerized**, and is currently **inactive** in the live `.env`.

Everything else labelled "AI" is **rule-based heuristics with no weights**:

- `mockProvider.js` — default `house-understanding` provider (pure jimp image math, no ML).
- `catalogRecommendationProvider.js` — rule-based color theory, constrained to catalog paints only.
- `colorSuggest.js` + `AISuggestionsTab.jsx` — client-side color math against the catalog, no inference.

Object removal / cleanup is **already fully external** (Clipdrop or Hugging Face Inference Providers behind `aiProxy.service.js`). The frontend runs **no model inference** (no TF.js / ONNX Runtime / Transformers.js / WebGPU).

So the migration surface is small: **one local Python service** plus the default provider pointer and the shared jimp helpers it pulls in.

---

## 2. Inventory table (the 17 audit columns)

Legend: columns are `Path / Function / Feature / Input / Output / Executed-or-placeholder / Size / Runtime / GPU / Browser? / Current endpoint / Caller / Unneeded deps / Env / Docker / Disposition`.

| Path | Function | Feature | Input | Output | Executed or placeholder | Size | Runtime | GPU | Browser | Endpoint | Caller | Unneeded deps | Env | Docker | Disposition |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `backend/vision-service/pipeline.py` | Grounded-SAM2 house-understanding pipeline (DINO detect + SAM2 segment + geometric trim/gutter derivation) | house-understanding | base64 PNG data URI → downscaled to 640px | `{scale, house, surfaces, objects, context}` (app contract) | **Executed real model** (downloads weights, runs inference) | ~421 lines; ~0 weight files in repo (weights downloaded to HF cache at first run) | First call: 10–60s+ model load (CPU); per image 2–15s+ CPU, much faster on CUDA | Optional (`cuda` if `torch.cuda.is_available()`); not required in dev | No (server-side Python) | `http://127.0.0.1:8008/analyze` via `httpVisionProvider` | `httpVisionProvider.js` when `AI_ANALYSIS_PROVIDER=http` | torch (heavy, unlisted in requirements.txt), transformers, numpy — all internal to the service | `AI_ANALYSIS_PROVIDER=http`, `AI_VISION_URL`, `AI_VISION_TIMEOUT_MS` | **Not containerized** (not in compose; backend image is node:20-alpine, no Python/torch) | Migrate to hosted vision API; then delete whole service |
| `backend/vision-service/server.py` | FastAPI HTTP entry (`POST /analyze`, `GET /health`) | house-understanding | `{"image": dataUri, "task": "house-understanding"}` | `{"output": {...}, "processingTimeMs"}` | Executed (thin wrapper) | 40 lines | ms (excludes model time) | n/a | No | `127.0.0.1:8008` | Node `httpVisionProvider` | fastapi/uvicorn (service-internal) | same as above | Not containerized | Delete with service |
| `backend/vision-service/requirements.txt` | Python deps | — | — | — | Executed | 6 lines | — | — | — | — | — | `torch` intentionally omitted (installed manually, CUDA-matched) | — | Not containerized | Delete with service |
| `backend/src/services/ai/providers/mockProvider.js` | Heuristic house-understanding (LAB/HSL classifiers, bbox projections, connected components, dilate) — **explicitly "a stand-in, not a model"** | house-understanding | image buffer (jimp) → downscale to ≤640px | `{scale, house, surfaces, objects, context}` (same contract) | **Executed but placeholder** (zero weights; cannot detect cars reliably / complex styles) | 574 lines | ~tens–100ms in-process, single-threaded | No | No | In-process (none) | `houseUnderstanding.service.js:38` via `aiRegistry.run('house-understanding', …)`; **this is the live default** (`AI_ANALYSIS_PROVIDER` unset) | jimp (needed here + httpVision + saveMask) | none required | none | Migrate to hosted vision API; remove after replacement verified |
| `backend/src/services/ai/providers/httpVisionProvider.js` | Generic HTTP vision adapter ("bring your own model"); PNG data URI POST + schema validation | house-understanding | image buffer → jimp PNG → `{image: dataUri, task}` | `{output}` validated to have `house/surfaces/objects/context` | Executed (adapter, no model) | 88 lines | bounded by `AI_VISION_TIMEOUT_MS` (60s default; 30s in .env.example) | No | No | `AI_VISION_URL` | `aiRegistry.run('house-understanding')` when provider selected | jimp (only for PNG encode) | `AI_VISION_URL` (required), `AI_VISION_API_KEY`, `AI_VISION_MODEL`, `AI_VISION_TIMEOUT_MS` | none | Repoint (or supersede) at a hosted vision API — the seam for the migration |
| `backend/src/services/ai/providers/catalogRecommendationProvider.js` | Rule-based color-theory schemes scored against catalog paints only | paint-recommendation | `{analysis, paints, count, productLines}` | `{schemes:[{id,name,tagline,surfaces:[{role,surfaceClass,paintId}]}]}` | **Executed, and intentionally NOT a model** — never invents a color | 229 lines | in-process, fast | No | No | In-process | `paintRecommendation.service.js:42` via `aiRegistry.run('paint-recommendation', …)` | none | `AI_RECOMMENDATION_PROVIDER=catalog` (default) | none | **Keep** — already satisfies the "catalog is source of truth" rule |
| `backend/src/services/ai/aiRegistry.service.js` + `aiConfig.js` + `aiResult.js` + `color.js` | Provider registry/capability dispatch + feature flags + result envelope + shared color math | (infra) | — | — | Executed (infra) | 73 + 71 + 35 + ~120 lines | ms | No | No | — | all AI services | — | flags `AI_ANALYSIS_ENABLED`/`AI_RECOMMENDATION_ENABLED`, provider selectors | none | Keep/extend (this is the abstraction the migration should reuse, not duplicate) |
| `backend/src/services/ai/houseUnderstanding.service.js` | Orchestration: read asset → job row → provider run → save masks → persist surfaces/objects → job outcome | house-understanding | assetId → `storage.readFile(asset.original_path)` | `{ok, job, house, context, scale, surfaces, objects, meta}` | Executed (orchestrator, provider-agnostic) | 125 lines | dominated by provider | No | No | `POST /api/assets/:assetId/ai/analyze` | `ai.controller.js` | jimp (only for `saveMask` PNG encode) | none | none | Keep (provider-agnostic by construction) |
| `backend/src/services/ai/paintRecommendation.service.js` | Orchestration: validate → provider → clear old batch → persist schemes → resolve paint rows | paint-recommendation | assetId (+optional count) | `{schemes:[…], meta:{provider, modelVersion, confidence, …}}` | Executed (orchestrator) | 113 lines | in-process | No | No | `POST /api/assets/:assetId/ai/recommendations` | `ai.controller.js` | — | flags/count | none | Keep |
| `backend/src/services/providers/clipdrop.js` | Clipdrop Cleanup API v1 (multipart image_file + mask_file, `x-api-key`) | object removal/cleanup | image buffer + optional mask buffer | cleaned image | Executed (external) | ~120 lines | external (30s httpClient default) | No (vendor) | No | `CLIPDROP_CLEANUP_URL=https://clipdrop-api.co/cleanup/v1` | `aiProxy.service.js` dispatcher | none | `AI_PROVIDER=clipdrop`, `CLIPDROP_API_KEY` | none | **Already external** — reference implementation for new analysis providers |
| `backend/src/services/providers/huggingface.js` | HF Inference Providers router (`router.huggingface.co/…`, Bearer, configurable JSON/binary/multipart, magic-byte validation) | object removal/cleanup | image buffer (+ optional mask) | cleaned image | Executed (external) | ~200 lines | external | No (vendor) | No | `HF_API_URL` | `aiProxy.service.js` | — | `HF_API_KEY`, `HF_MODEL`, `HF_API_URL`, `HF_INPUT_MODE`, `HF_JSON_SHAPE`, `HF_PROMPT`… | none | Already external; the live default in current `.env` |
| `backend/src/services/providers/httpClient.js` | Shared HTTP client: 30s timeout, retry 429/503/504 (backoff 500ms·2ⁿ cap 4s), `ProviderError` (status/provider/model/requestId/retriable), structured logs | (infra) | — | — | Executed | ~150 lines | — | No | No | — | all providers | — | — | none | Keep — shared by all external providers |
| `frontend/src/shared/lib/colorSuggest.js` | Client-side rule-based color suggestions (context extraction outside paintable mask + LAB-distance scoring vs catalog) | paint suggestion (UI) | `ImageData` + mask `ImageData` + catalog rows | ranked catalog paints | Executed, **no ML** (explicit "no ML model call") | 118 lines | in-process, sampled grid | No | **Yes** — runs in browser | none (uses `useCatalogList` → backend catalog) | `AISuggestionsTab.jsx` | — | — | none | **Keep** (no inference; catalog stays backend-sourced) |
| `frontend/src/features/visualizer/panels/AISuggestionsTab.jsx` | UI for suggestions, `applySuggestion` commits via history | paint suggestion (UI) | active layer mask + base image | suggestions UI | Executed | 93 lines | — | No | Yes | — | SidePanel tab | — | — | none | Keep |
| `frontend/src/features/visualizer/panels/AIAnalyzeTab.jsx` | Analysis status/trigger UI (renders job meta, surface list) | house-understanding (UI) | analysis API response | UI | Executed | ~110 lines | — | No | Yes | `POST /api/assets/:assetId/ai/analyze` etc. | SidePanel tab | — | — | none | Keep (UI only) |
| `frontend/src/features/visualizer/tools/maskOps.js` | Client-side mask drawing/editing (explicitly *no segmentation model*, requirements §5.2) | mask editing (UI) | pointer events + mask ImageData | edited mask | Executed | ~340 lines | — | No | Yes | none | Visualizer tools | — | — | none | Keep (client-side rendering/editing is out of scope for migration) |
| `frontend/src/features/visualizer/panels/RecommendationsTab.jsx`, `renderSchemePreview.js`, `colorEngine.js`, `maskImage.js` | Scheme previews + paint-color rendering pipeline (canvas) | paint visualization (UI) | base image + masks + paint RGB | previews | Executed (client-side rendering — **not** inference) | see prior incidents | heavy at full-res 1600×1200 | No | Yes | none | Visualizer | — | — | none | Keep (subject to the two prior crash-repair reports) |

---

## 3. Dimension-by-dimension findings

### 3.1 Executed vs placeholder
- **Real trained model:** only `backend/vision-service/pipeline.py` (Grounding DINO `IDEA-Research/grounding-dino-tiny` + SAM2 `facebook/sam2-hiera-tiny`, downloaded from Hugging Face Hub on first run).
- **Placeholder stand-ins:** `mockProvider.js` (self-documented "stand-in, not a model"). `catalogRecommendationProvider.js` and `colorSuggest.js` are **intentional rule engines**, not placeholders — they are the product's chosen explainable behavior for recommendation, and they already obey "AI must never invent paint colors".

### 3.2 Size / model artifacts
- **No model weights committed** anywhere. The only weight files are the two HF Hub checkpoints pulled into `~/.cache/huggingface` at first run of the vision service (dino-tiny ≈ hundreds of MB, sam2-hiera-tiny similar — not in the repo).
- Search coverage: `**/*.{py,pt,pth,onnx,safetensors,ckpt,gguf,tflite,bin,weights,h5,keras}` and the frontend package deps returned nothing else.

### 3.3 Runtime & GPU
- Mock/catalog/color engines: in-process, fast, CPU-only, no GPU.
- Vision-service: CPU-first in dev (`DEVICE = cuda if available`), model load dominates first request; heavy for a synchronous 30–60s HTTP round trip.

### 3.4 Browser involvement
- **No model inference in the browser** — confirmed by package.json (no TF.js/ONNX Runtime/Transformers.js/WebGPU) and by `maskOps.js`/`colorSuggest.js` comments. All browser AI-adjacent code is canvas rendering, mask editing, or catalog color math. Nothing to remove.

### 3.5 Current endpoints & callers
- `house-understanding`: in-process by default (`mock`); `http-vision` points at `AI_VISION_URL` (currently the local service on `127.0.0.1:8008`, inactive in the live `.env`).
- `paint-recommendation`: `catalog` in-process.
- `object removal/cleanup`: external only — `aiProxy.service.js` → `clipdrop` (default by code) or `huggingface` (current `.env`), keys backend-only.

### 3.6 Unneeded / heavy deps
- `torch` + `transformers` + `numpy` live entirely inside `backend/vision-service/` (deleted with it after migration). The Node backend's only AI-related dep is `jimp ^0.22.12`, used by the mock provider, `httpVisionProvider` PNG encode, and `houseUnderstanding.saveMask`. Once analysis is fully external, jimp use shrinks to mask persistence only (and can eventually drop if masks are saved as-is from the provider).
- `backend/package.json` already describes the backend as one that "proxies hosted AI API calls" — the codebase intent is aligned with the migration target.

### 3.7 Env / Docker deltas
- Live `.env` has no `AI_ANALYSIS_PROVIDER` (→ `mock`), no `AI_VISION_URL` (vision-service unused by default); cleanup is `AI_PROVIDER=huggingface` with a configured `HF_API_URL` (partner router, billed — needs pre-paid credits/PRO, HTTP 402 otherwise).
- No container change is needed to remove local AI: the vision-service was never in `docker-compose.yml`, and `backend/Dockerfile` (node:20-alpine) has no Python/torch. Migration is net *negative* on infra.

---

## 4. Capability map (current → target)

| Capability | Current local path | External target | Notes |
|---|---|---|---|
| house-understanding (analysis/segmentation) | vision-service (optional) / mock (default) | hosted vision API via `httpVisionProvider` contract | Keep the structured `{house, surfaces, objects, context}` contract as the seam; add provider behind registry |
| paint-recommendation | catalog (rule-based, catalog-only) | **keep as-is** (no change) | Already externalization-safe and catalog-constrained; swap provider only if a learned recommender is later justified |
| object removal / inpainting | none (already external) | Clipdrop / HF (existing) | Keep; reuse `httpClient.js` + `ProviderError` + retry/backoff for new providers |
| UI suggestions | colorSuggest.js (client-side, catalog-scored) | **keep** (no change) | Not inference; catalog fetched from backend |

---

## 5. Migration recommendations (Phase 2 preview — no changes made)

1. **Do not duplicate the registry.** Extend `aiRegistry.service.js` / `aiConfig.js`; the provider interface (`id`, `version`, `supports(capability)`, `run(capability, input) → {output, confidence, modelVersion}` + `aiResult` envelope) already fits hosted providers.
2. **Replace `mock` with a hosted house-understanding provider** behind the same contract (`httpVisionProvider.js` is the existing drop-in; either point it at a hosted endpoint or add a dedicated provider that reuses `httpClient.js`). Keep `mock` only as an offline/dev fallback while the hosted provider is validated, then remove it and `backend/vision-service/`.
3. **Free-tier / vendor selection** for structured understanding (house/surfaces/objects/context) must be documented against the contract's needs (pixel masks per surface/object, context colors) — segmentation-heavy; a generic chat-vision API alone cannot produce the masks without a wrapper.
4. **Keys stay backend-only** (as today: `HF_API_KEY`, `CLIPDROP_API_KEY`, `AI_VISION_API_KEY` are env-only; never in Vite env, localStorage, or frontend payloads).
5. **Controlled errors:** reuse `ProviderError`/retry/backoff and the `ai_jobs` audit trail; user-facing copy stays generic ("AI processing is temporarily unavailable…"), details in backend logs.
6. **Heavy ops → jobs:** analysis and cleanup already persist `ai_jobs`; keep the async pattern so a slow hosted provider never blocks an HTTP response indefinitely.
7. **Deletion is last**, and only of: `backend/vision-service/`, `mockProvider.js`, and any now-unused jimp paths — after the hosted provider is verified in all three phases (analysis → segmentation/masks → removal; recommendations unchanged).

---

## 6. Files that stay untouched (no local AI, but on the migration path)

- `aiProxy.service.js`, `providers/{clipdrop,huggingface,httpClient}.js` — external-cleanup reference architecture.
- `aiJobs.model.js`, `paintRecommendation.model.js`, `paintRecommendation.service.js`, `houseUnderstanding.service.js` — provider-agnostic orchestration/persistence.
- `ai.controller.js`, `ai.routes.js` — API surface (unchanged by provider swap).
- Frontend panels + `colorEngine.js`/`colorSuggest.js`/`maskOps.js` — UI/rendering only.
