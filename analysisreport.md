# Paint Visualizer — Forensic Audit Report

**Audit date:** 2026-08-10
**Audit target:** `C:\Users\Lenovo\Downloads\paint-visualizer (1)\paint-visualizer` (working tree, branch `feat/ai-house-understanding`)
**Audit type:** Static code review + live execution verification. **No source code was modified.**
**Methods:** direct file reads, targeted grep, `git status`/`git log`/`git ls-files`, `npm test` (backend + frontend), directory inventory, .env configuration inspection.

---

## 0. Audit Principles (binding constraints)

1. **Never modify/refactor/fix** — analysis only. This report changes nothing in the repository.
2. **Evidence over assumptions** — every finding cites a `file:line` or a command result. Unverifiable claims are flagged UNKNOWN, never guessed.
3. **Distinguish "Implemented", "Implemented but Broken", and "Not Actually Implemented".** These are different classifications and are reported separately.
4. **Secrets are reported without exposing values** (location, type, severity, action only).
5. **No severity inflation** — findings are graded by real exploitability given the deployment posture this code actually has.

### Classification legend

| Class | Meaning |
|---|---|
| FULLY IMPLEMENTED | Works as documented; verified by code path + tests where possible |
| PARTIALLY IMPLEMENTED | Works for the main path; edge cases missing or deliberately scoped out |
| PLACEHOLDER | A real, non-functional stand-in that is *intended* to be replaced |
| MOCKED | Deliberate fake/simulated implementation, clearly labeled, test-only |
| STUB | Function exists but returns immediately / throws *not implemented* |
| BROKEN | Code present but does not do what it claims, or crashes |
| DEAD | Present but unreachable / zero call sites / never persisted |
| DUPLICATED | Same logic exists in >1 place with drift risk |
| UNKNOWN | Cannot be verified from the repo alone (requires runtime/network/DBA access) |

---

## 1. Executive Summary

This is a single-page React + Express + MySQL paint-visualization app ("pick a paint color, preview it on a photo of a house"). The core loop — upload a photo, draw/recolor surfaces via canvas + Konva, persist layers, export images — is **fully implemented and tested (117/117 tests pass: 76 backend + 41 frontend)**.

The "AI" surface area (house understanding, autonomous pipeline, object removal, paint recommendations) is a **real, well-engineered architecture that is currently **disabled** in the working configuration and whose flagship path is **not operational out of the box**:

- `AI_ANALYSIS_ENABLED=false` in `backend/.env` — the entire house-understanding + recommendations chain is off.
- Both `mockProvider` and the two real `http-vision`/`hf-vision` analysis providers have been **removed/unregistered** in the working tree; no analysis provider is currently registered, so even flipping the flag would not work.
- `AI_RECOMMENDATION_PROVIDER=hf-scheme` depends on analysis output that never exists → recommendations are unreachable in the current env.
- The only live AI feature is **object removal (cleanup)**, which is independent of analysis (falls back to a heuristic default mask) and calls a hosted FLUX.2-edit model through a router key present in `backend/.env`.

The docs (`README.md`, `DOCUMENTATION.md`, both audit MDs) **contradict the current code on multiple counts**: they repeatedly claim "mock provider ships by default, zero API keys, AI works out of the box." That is no longer true in the working tree. See §28.

**Security posture is reasonable for a local dev tool but fail-open by design**: one shared API key that is accepted even when unset or still `'change-me-long-random-string'` (`keyNotConfigured()`); `/files/*` serves any stored asset to anyone with the key or even without it when the key is unconfigured; several real secret values exist at rest in `backend/.env` (a 37-char HF router key, a 21-char ClipDrop key, DB password). None are committed to git (`.env` is ignored, verified via `git ls-files`).

**Highest-value findings (full register in §34):**

| # | Finding | Class | Severity |
|---|---|---|---|
| F-01 | AI house-understanding + recommendations **not operational** in current config (flag off + no registered provider) | PARTIALLY IMPLEMENTED (dead-in-config) | High |
| F-02 | Docs claim mock/AI-on-by-default that no longer matches code | DOCS-DRIFT | High |
| F-03 | API key fail-open when unset/unchanged; auth is nominal | Security | Medium |
| F-04 | `/files/*` served with `key` query param + symmetric with API key | Security | Medium |
| F-05 | Secrets at rest in `backend/.env` (HF router key, ClipDrop key, DB pwd) | Security | Medium |
| F-06 | docker-compose defaults `AI_ANALYSIS_PROVIDER=mock` → would break if used (provider unregistered) | BROKEN (compose-only) | Medium |
| F-07 | `pageSize` unbounded in `/api/catalog` list (LIMIT injection) | Security/Perf | Low |
| F-08 | `listProjects` unpaginated | Perf | Low |
| F-09 | Error handler leaks internal `err.message` to clients | Security | Low |
| F-10 | Cleanup endpoint only guarded by generic 20/15-min limiter; no per-asset dedupe | DoS | Low |
| F-11 | Pipeline lock is in-memory `Set` (single-process only) — DB constraint `uq_ai_jobs_running` compensates | Concurrency | Info |
| F-12 | Large dead-code chains documented but still present (see §29) | Dead | Low |
| F-13 | 14 stale/contradictory doc claims (full table in §28) | Docs | Info |

---

## 2. Repository Snapshot & Provenance

### 2.1 Git state
- Branch: `feat/ai-house-understanding`, HEAD `3543ec0` — *"feat(ai): autonomous pipeline, surface validation, house-aware removal, ranked schemes, security hardening"*.
- Commit history (oldest→newest):
  1. `1d4bae0` — initial MVP
  2. `3b27aca` — object removal
  3. `a5db303` — object removal (2nd enhancement)
  4. `62fbe58` — 2nd enhancement
  5. `84ffe3d` — 2nd enhancement
  6. `e0e2c2b` — AI house understanding
  7. `04f3aeb` — idempotent AI layers
  8. `a2d1be6` — OOM crash fix (see §31)
  9. `3543ec0` — autonomous pipeline, surface validation, house-aware removal, ranked schemes, security hardening

### 2.2 Uncommitted work (critical context)
The working tree is **significantly ahead of HEAD**. `git status` shows a large dirty set: modified models/controllers/services/routes/middleware, deleted files, and staged new files. The *audit target is the working tree as it currently stands* — i.e., HEAD + uncommitted changes — because that is what a developer will run/build.

Key deltas from HEAD (this is what makes the docs stale):
- **DELETED:** `backend/vision-service/` (entire local vision service), `providers/hfVisionProvider.js`, `providers/httpVisionProvider.js`, `services/ai/visionAssembly.js`, `scripts/smokeVisionAssembly.js`.
- **ADDED:** `hfSchemeProvider.js` (hosted LLM scheme recommender), `uploadValidation.middleware.js` (+ test), `requestId.middleware.js`, `inFlightLock.service.js` (+ test), `removalQuality.service.js` (+ test), `catalogRecommendationProvider.test.js`, `hfSchemeProvider.test.js`, plus several other tests.
- **MODIFIED:** `.gitignore`, `backend/.env.example`, `backend/package.json`, `app.js`, `aiConfig.js`, `assets.controller.js`, `importExport.controller.js`, `errorHandler.middleware.js`, all major routes, `runSchema.js`, `server.js`, AI services, `aiJobs.model.js`, `excelImport.service.js`, storage.service (async rewrite), etc.
- Untracked: `backend/.env`, `frontend/.env` (gitignored), `image.png`, dist artifacts, and more.

**Audit caveat:** staged vs unstaged content may differ on some files; findings cite the *current on-disk content*, which is the runnable state.

### 2.3 Repository layout
```
paint-visualizer/
├─ backend/          Express API (src/), schema.sql, Dockerfile, package.json
├─ frontend/         React/Vite SPA (src/), Dockerfile, package.json, tests
├─ docs/             AI_VISUALIZER_ARCHITECTURE_AUDIT.md, AI_VISUALIZER_FINAL_IMPLEMENTATION_REPORT.md
├─ AI_LOCAL_MODEL_AUDIT.md, AI_SCHEMES_AUDIT.md, AI_SCHEMES_CRASH_INCIDENT.md,
│  AI_SCHEMES_ACTIVATION_CRASH_FORENSIC.md   (root-level incident/audit docs)
├─ DOCUMENTATION.md  (851-line functional spec + design doc)
├─ README.md         (96-line quickstart)
├─ docker-compose.yml
└─ image.png
```

---

## 3. Methodology & Verification Log

### 3.1 Tools used
- `git log`, `git status`, `git ls-files` — provenance & tracked-file verification
- Direct `Read` of ~50 files; `Grep` across JS sources for TODO/FIXME/placeholder markers, secrets patterns, and cross-references
- `npm test` in `backend/` and `frontend/` (live run)
- Directory inventory (`backend/uploads`, `frontend/dist`)
- `.env` key inspection (values redacted in this report)

### 3.2 Tests executed (live, this audit)
| Suite | Result |
|---|---|
| Backend `npm test` (`node --test`) | **76 passing, 0 failing** (incl. DB-constraint test hitting real MySQL ~3.2s, in-memory no mock provider) |
| Frontend `npm test` | **41 passing, 0 failing** (incl. colorEngine, maskOps, layer/color ownership) |
| **Total** | **117 / 117 pass** |

Note: because the working tree deletes the mock/vision providers and their tests, the *current* test suite does not exercise any house-understanding provider. The AI path is therefore covered only by pipeline/lock/quality unit tests and by the provider tests that remain (catalogRecommendationProvider, hfSchemeProvider).

### 3.3 What could NOT be verified (UNKNOWN items)
- Live end-to-end AI analysis against a real provider (none registered; flag off).
- Live object-removal call against the hosted model (requires key + network; not executed).
- MySQL behavior beyond what `node --test` exercised (schema.sql not re-applied).
- Multi-process behavior of the in-memory pipeline lock (single process only).
- Real-world performance beyond observed `backend/uploads` (797 files / 36.1 MB) and `frontend/dist` (3 files / 0.92 MB).

---

## 4. Tech Stack Inventory

### 4.1 Backend (`backend/package.json`)
- **Runtime:** Node.js (Dockerfile uses node:20-alpine)
- **Framework:** Express 4.19.2
- **DB:** mysql2 3.10 (pool, `dateStrings`, limit 10)
- **Validation:** zod 3.23
- **Uploads:** multer
- **Image processing:** jimp 0.22
- **Excel:** xlsx 0.18.5
- **Security middleware:** helmet, cors, morgan, express-rate-limit 7.2
- **Misc:** uuid 9, dotenv
- **Dev:** nodemon. **Tests:** built-in `node --test` (no jest/vitest)

### 4.2 Frontend (`frontend/package.json`)
- **UI:** React 18.3.1, Vite 5.3, Tailwind 4 (`@tailwindcss/vite`)
- **Canvas:** Konva 10.3 + react-konva 18.2
- **State:** zustand 5, @tanstack/react-query 5.101
- **Routing:** react-router-dom 6.24
- **UI kit:** radix-ui (dialog, slider, tabs, toast, tooltip), framer-motion, lucide-react, cva/clsx/tailwind-merge
- **Persistence:** idb-keyval (IndexedDB drafts), localStorage (favorites/collections)
- **Tests:** 41 passing (colorEngine, maskOps, color ownership, etc.)

### 4.3 Notable absences
- **No lint config, no formatter config, no CI** anywhere (`.github/` absent, no `lint` script in either package.json). No TypeScript anywhere.

---

## 5. Architecture Overview

```
┌─────────────────────────── FRONTEND (React SPA, port 5173) ───────────────────────────┐
│ Dashboard / Projects / Visualize (per-project) / Catalog                                │
│ Konva canvas ← LayerNode compositing; colorEngine.js (LAB recolor); maskOps.js          │
│ zustand visualizerStore + TanStack Query; idb drafts; localStorage favorites            │
│ api.js → fetch to :4000 (x-api-key header, 15s/60s AbortController timeouts)            │
└──────────────┬──────────────────────────────────────────────────────────────────────────┘
               │ HTTP :4000  (cors CORS_ORIGIN, helmet, morgan, rate-limit, request-id)
┌──────────────▼──────────────────────────── BACKEND (Express) ──────────────────────────┐
│ app.js → routes: /api/catalog, /api/projects(+assets/layers/history/concepts/exports), │
│        /api/assets(+/clean/duplicate/ai/*), /api/meta, /files/*                         │
│ middleware: accessKey (x-api-key), uploadValidation (magic bytes + 8000px cap),         │
│             requestId, errorHandler (logs stack, returns err.message)                   │
│ services: storage (fs/promises, containment guard), excelImport (preview/commit txn),   │
│           logger (JSON, 5MB rotation), aiProxy (clipdrop/huggingface dispatcher)        │
│ AI layer: aiRegistry {catalogRecommendationProvider, hfSchemeProvider};                 │
│           houseUnderstanding (withLock), paintRecommendation, aiPipeline (Phase 2),     │
│           objectRemovalMask (house-aware), removalQuality, surfaceQuality,              │
│           objectClassification, inFlightLock (Set)                                     │
│ models: projects, assets, layers, aiJobs (DB lock via uq_ai_jobs_running), paints,      │
│         paintRecommendation, concepts, exports, history, import_log                     │
└──────────────┬──────────────────────────────────────────────────────────────────────────┘
               │ mysql2 pool (limit 10)
        ┌──────▼────────┐   ┌──────────────────────────────┐
        │ MySQL 8.0      │   │ Hosted AI (key-driven)       │
        │ paints,        │   │ HF router: FLUX.2 edit (clean)│
        │ projects,      │   │ HF router: Llama-3.1 scheme  │
        │ assets, layers,│   │ ClipDrop cleanup (fallback)  │
        │ ai_jobs, ...   │   └──────────────────────────────┘
        └───────────────┘
```

### 5.1 Key design decisions evidenced in code
- **Analysis disabled at config level** (`aiConfig.js` returns `null` when `AI_ANALYSIS_ENABLED` is falsy; `backend/.env` sets it `false`).
- **No production analysis provider registered** (`aiRegistry.service.js` — mock deliberately not registered; `http-vision`/`hf-vision` deleted).
- **Recommendations are catalog-constrained by design** (never returns colors outside the catalog; hfSchemeProvider maps LLM HSL output to nearest catalog paint).
- **House-understanding is now primarily a *recommendation pipeline*, not a removal input** — removal uses its own heuristic mask builder, so cleanup still works without analysis (this is deliberate per code comments).
- **`/clean` is deliberately excluded from the autonomous pipeline** (documented product decision; pipeline = analyze → surfaces → recommendations only).

---

## 6. Backend Inventory

### 6.1 Source tree (by directory)
```
backend/src/
├─ app.js, server.js
├─ config/            db.js (pool 10, dateStrings), aiConfig.js
├─ controllers/       paints, projects, assets, layers, importExport, exports, meta, ai, concepts, history
├─ middleware/        accessKey, errorHandler, requestId, uploadValidation (+test)
├─ routes/            api.js (mount), plus per-domain route files
├─ services/          projects.model, assets.model, layers.model, paints.model,
│                     paints.validation, paintRecommendation.model, aiJobs.model,
│                     concepts.model, exports.model, history.model,
│                     excelImport.service, storage.service, aiProxy.service,
│                     httpClient, logger.service
│   └─ ai/            aiRegistry, mockProvider, catalogRecommendationProvider,
│                     hfSchemeProvider, houseUnderstanding.service,
│                     paintRecommendation.service, aiPipeline.service,
│                     objectRemovalMask.service, removalQuality.service,
│                     surfaceQuality.service, objectClassification, inFlightLock.service
├─ sql/               schema.sql
└─ scripts/           runSchema.js, reconcileUploads.js
```

### 6.2 Middleware assessment
| Middleware | Verdict | Notes |
|---|---|---|
| `accessKey` | PARTIALLY IMPLEMENTED | Single shared `x-api-key`; **fail-open** when unset or still default (`keyNotConfigured()`). No per-user auth — deliberate for local dev |
| `uploadValidation` | FULLY IMPLEMENTED | Magic-byte `isRealImage`/`isRealXlsx`; `MAX_IMAGE_DIMENSION 8000px` decompression-bomb guard; WEBP falls back to size/magic; xlsx empty-workbook gap closed |
| `requestId` | FULLY IMPLEMENTED | X-Request-Id correlation; consumed by frontend logger |
| `errorHandler` | PARTIALLY IMPLEMENTED | Logs full stack server-side; returns only `err.message` to client (info-leak vector, low) |

---

## 7. Frontend Inventory

### 7.1 Routing
| Route | Component | Verdict |
|---|---|---|
| `/` | redirect → `/dashboard` | FULLY |
| `/dashboard` | Dashboard | FULLY |
| `/projects` | Projects | FULLY |
| `/visualize` | redirect → first project | FULLY |
| `/projects/:projectId/visualize` | VisualizerWorkspace (+ onColorFocus) | FULLY |
| `/catalog` | CatalogPage | FULLY |

No route guards / login. Auth is the static shared `x-api-key` header via `api.js`.

### 7.2 Feature surface (key modules)
| Module | Verdict | Evidence |
|---|---|---|
| `api.js` (API client) | FULLY | 15s/60s AbortController timeouts (fixes prior H-06); catalog export via blob (fixes prior /files link 401); `/files` URLs carry `?key=` |
| `visualizerStore` (zustand) | FULLY | Owns active asset/layer/color state |
| Canvas compositing (Konva) | FULLY | LayerNode + `colorEngine.js` LAB recolor + `maskOps.js` alpha=selection-strength 0–255 contract |
| `useHistoryCommand` | FULLY | Command pattern, optimistic + rollback, persisted `undo_pointer` |
| AI tabs (AIAnalyzeTab, RecommendationsTab, AiPipelineStatusBar) | PARTIALLY | Present and wired to `/api/.../ai/*`, but greyed out when `/api/meta` reports analysis disabled (it is, in current env) |
| Drafts (idb-keyval) | FULLY | Unsaved-work recovery |
| Favorites/collections (localStorage) | FULLY | Catalog filtering |

---

## 8. Data Model Analysis (`backend/src/sql/schema.sql` + models)

Tables (from schema + models): `paints`, `projects`, `assets`, `layers`, `ai_jobs`, `paint_recommendation`, `concepts`, `exports`, `history`, `import_log`.

| Table | Assessment |
|---|---|
| `paints` | FULLY — soft-delete (`is_deleted`), 7 product-line booleans, RGB, unique `color_code`; SQL init script at DB container start |
| `projects` | FULLY — `cover_asset_id` join for thumbnails; `undo_pointer`; updated_at concurrency |
| `assets` | FULLY — UUID PK, `original_path`/`cleaned_path`, `status` machine (uploaded/cleaning/cleaned/failed), `exif_orientation` column present but **never written/read (DEAD column)** |
| `layers` | FULLY — `upsertAiLayer` idempotent on `(ai_analysis_id, ai_surface_key)`; `CREATED_VIA_VALUES` incl. `ai-surface`; `order_index`; soft-delete + `restore` |
| `ai_jobs` | FULLY — DB-enforced single-running-job via generated-column unique index `uq_ai_jobs_running` (multi-instance safe; complements in-memory lock) |
| `paint_recommendation` | FULLY — persisted recommendations keyed to analysis |
| `concepts`, `exports`, `history`, `import_log` | FULLY |

### 8.1 Notables
- **`uq_ai_jobs_running`** is the real guarantee; the in-memory `Set` in `inFlightLock.service.js` is best-effort per-process (§F-11).
- **`exif_orientation`** dead column — documented in DOCUMENTATION §11.2 as "to be completed".
- `paints.list` passes `pageSize` **unclamped** into `LIMIT ?` (`paints.model.js:22-24`) — parameterized (no SQLi) but unbounded result sets (§F-07).

---

## 9. API Surface Inventory

Verified against `routes/*` and `app.js`. All `/api` paths gated by `accessKey`.

| Method | Path | Purpose | Verdict |
|---|---|---|---|
| GET | `/api/meta` | Feature flags (AI enabled/providers, limits) | FULLY |
| GET/POST | `/api/catalog` | list/create paints | FULLY (list pageSize unclamped, F-07) |
| GET/PUT/DELETE | `/api/catalog/:id` | get/update/soft-delete | FULLY |
| POST | `/api/catalog/import/preview` | Excel preview (magic-byte verified) | FULLY |
| POST | `/api/catalog/import/commit` | transactional import (create/update/revive) | FULLY |
| GET | `/api/catalog/import/export` | blob-exported XLSX | FULLY |
| GET/POST | `/api/projects` | list/create | FULLY (list unpaginated, F-08) |
| GET/PATCH/DELETE | `/api/projects/:id` | get/update(+updatedAt)/delete | FULLY |
| PATCH | `/api/projects/:id/undo-pointer` | persist undo pointer | FULLY |
| GET/POST | `/api/projects/:projectId/assets` | list/upload (rate-limited 20/15min) | FULLY |
| GET/PATCH/DELETE | `/api/assets/:id` | get/rename/delete (+disk cleanup) | FULLY |
| POST | `/api/assets/:id/duplicate` | copy asset + files | FULLY |
| POST | `/api/assets/:id/clean` | object removal (rate-limited; mask fallback) | FULLY |
| GET/POST | `/api/assets/:id/layers` | list/create | FULLY |
| PATCH/DELETE | `/api/layers/:id` | update(multipart mask)/delete | FULLY |
| POST | `/api/layers/:id/restore` | restore soft-deleted | FULLY |
| POST | `/api/assets/:id/ai/analyze` | house understanding (disabled in env) | PARTIALLY |
| GET | `/api/assets/:id/ai/analysis` | fetch stored analysis | PARTIALLY |
| POST/GET | `/api/assets/:id/ai/recommendations` | generate/list | PARTIALLY (env-blocked) |
| POST/GET | `/api/assets/:id/ai/process` / `status` | autonomous pipeline | PARTIALLY (env-blocked) |
| GET/POST | `/api/projects/:projectId/history` | undo log | FULLY |
| GET/POST | `/api/projects/:projectId/concepts` | saved looks | FULLY |
| GET/POST | `/api/projects/:projectId/exports` | exports | FULLY (PNG/JPG) |
| GET | `/api/exports/:id` | fetch export | FULLY |
| GET | `/files/*` | serve stored assets (`?key=` query) | FULLY (see F-04) |
| — | `POST /api/.../exports/pdf` | **501 deferred server-side** | STUB (by design, F-14) |

---

## 10. Authentication & Access Control

### 10.1 Design (as implemented)
- One shared `x-api-key` for every `/api` route. Frontend sends it from `VITE_API_ACCESS_KEY`.
- `keyNotConfigured()` returns true when `API_ACCESS_KEY` is **unset** or still equal to the default `'change-me-long-random-string'` → **all API routes open** in that state (`backend/.env.example` ships that default).
- `/files/*` has **its own guard** accepting the key either as `x-api-key` header *or* as a `?key=` query param (frontend uses query param because `<img>`/Konva can't set headers).
- No users, no roles, no sessions, no CSRF tokens (SPA with shared static key).

### 10.2 Assessment
- **Fail-open is intentional and documented** for local dev, but it means the "security hardening" commit's auth is nominal until a real key is set **and** the environment is deployed remotely.
- The 21-char dev key in the untracked `.env` files (`pv-local-key-dev-2026`) is shared verbatim across backend and frontend and would grant full read/write/delete/AI-call access to anyone who obtains it. Class: **Security — Medium** (Local).
- No rate limit on auth failures (none possible — single key); cleanup/upload are the only rate-limited paths (20/15min).

---

## 11. Secrets & Credential Handling

### 11.1 Secrets found (values redacted)
| Location | Type | State | Severity |
|---|---|---|---|
| `backend/.env` (untracked, gitignored) | `HF_API_KEY` (37 chars, real router key) | **SECRET FOUND** — at rest, plaintext, gitignored | Medium |
| `backend/.env` (untracked) | `CLIPDROP_API_KEY` (21 chars, real key) | **SECRET FOUND** — at rest, plaintext, gitignored | Medium |
| `backend/.env` (untracked) | `DB_PASSWORD` (9 chars, likely `change-me`) | Weak but local-only | Low |
| `backend/.env` (untracked) | `API_ACCESS_KEY` (21 chars, dev key `pv-local-key-dev-2026`) | Dev credential shared BE/FE | Low |
| `frontend/.env` (untracked) | `VITE_API_ACCESS_KEY` (21 chars, same dev key) | Injected into the client bundle at build | Low |
| `backend/.env.example` (tracked) | `API_ACCESS_KEY=change-me-long-random-string` | Template placeholder — safe | None |
| `docker-compose.yml` (tracked) | `MYSQL_ROOT_PASSWORD: root_change_me` / `change-me` | Compose-only default | Low |

### 11.2 Handling verification
- `.gitignore` covers `.env`, `.env.*.local`, `backend/.env`, `frontend/.env` (with `!.env.example` exceptions). **Verified via `git ls-files`: only the two `.env.example` files are tracked. No committed secrets.**
- Backend never echoes keys; HF router key is backend-only (never sent to frontend).
- Frontend key is a build-time constant (inherently exposed in the SPA — accepted design for a shared-key tool).
- **Action (report-only):** rotate the HF router key if the machine/repo has left the owner's control; document key management in a secrets policy; consider CI secret scanning (none exists).

---

## 12. AI — House Understanding (deep dive)

### 12.1 Status
| Aspect | Verdict |
|---|---|
| Data model (analysis → surfaces/objects + masks + versioned jobs) | FULLY IMPLEMENTED |
| Orchestration (`houseUnderstanding.service`, `withLock` per asset, disabled-capability check) | FULLY IMPLEMENTED |
| Provider seam (`aiRegistry`) | FULLY IMPLEMENTED but **no provider registered** |
| Production analysis provider | **MOCKED → REMOVED**. `mockProvider` deleted from registry (deliberately, per header comment); `http-vision` and `hf-vision` providers + `visionAssembly` + `backend/vision-service/` **deleted** in working tree |
| Default provider | **None.** `aiConfig.js` yields `null` when `AI_ANALYSIS_ENABLED` falsy (it is `false` in `backend/.env`) |
| Result | **NOT OPERATIONAL in current config.** `GET /api/meta` → analysis `enabled: false` → UI greyed out. Even with flag on, no provider exists to run |

### 12.2 Why this is "implemented but not operational"
- `aiConfig.js` — `AI_ANALYSIS_PROVIDER || null`, and `AI_ANALYSIS_ENABLED=false` in `backend/.env`.
- `aiRegistry.service.js` — `PROVIDERS = [catalogRecommendationProvider, hfSchemeProvider]`; mock explicitly **not** registered; comment states no production provider registered right now.
- Docs (README/DOCUMENTATION) still claim mock is the shipped default → see §28 F-13 rows 1–6.

---

## 13. AI — Paint Recommendations (deep dive)

| Provider | Verdict | Notes |
|---|---|---|
| `catalogRecommendationProvider` | FULLY IMPLEMENTED | Rule-based (ROLE_BY_CLASS, ROLE_ORDER), catalog-only colors, `keep:true` roof option, house-context affinity nudge; unit-tested |
| `hfSchemeProvider` | FULLY IMPLEMENTED | Real hosted LLM via HF router → HSL targets → nearest catalog paint; `AI_SCHEME_MODEL` default `meta-llama/Llama-3.1-8B-Instruct`; defense-in-depth catalog check; unit-tested |
| Activation | **BLOCKED in current env** | Requires analysis output; `AI_RECOMMENDATION_PROVIDER=hf-scheme` set, but analysis is off → generation never reaches the provider |

### 13.1 `mockProvider` (MOCKED)
Deterministic Jimp heuristics, test-only fixture, header explicitly says safe to delete if unimported. **Correctly kept out of the production registry.** This is the *only* MOCKED classification in the repo.

---

## 14. AI — Object Removal (deep dive)

### 14.1 Status: **FULLY IMPLEMENTED and the only live AI feature**
- `assets.controller.js:66-114` — `requestCleanup`:
  - explicit user mask wins; else `objectRemovalMask.buildDefaultRemovalMask` (house-aware: REMOVABLE_CLASSES tree/car/person/fence, house surfaces stamped back to keep, white=remove/black=keep);
  - **independent of house-understanding** (works with no analysis — deliberate per comments);
  - `removalQuality.checkHouseDamage` rejects the result if it would alter the house itself (`CHANGE_DISTANCE_THRESHOLD=40`, `DAMAGE_FRACTION_THRESHOLD=0.08`; unverifiable → let through); rejected results are reverted to `uploaded` with a user-facing error, original retained;
  - result saved as `cleaned.jpg`; status machine `uploading→cleaning→cleaned/failed`.
- Backend calls `aiProxy` → `huggingface` provider (FLUX.2 edit via router) with ClipDrop fallback.
- **Verdict:** fully implemented, unit-tested (removalQuality, objectClassification), enabled in current env (HF key present). Live end-to-end network call NOT executed during audit (UNKNOWN as to model quality).

---

## 15. AI — Autonomous Pipeline

- `aiPipeline.service.js` — Phase 2 chain: analyze → surfaces → recommendations. Idempotent unless `force:true`. Derived status from `ai_jobs` (no new table). `inFlightLock` in-memory `Set`.
- `/clean` deliberately **not** in the pipeline (documented product decision).
- Multi-instance safety: DB constraint `uq_ai_jobs_running` (generated column) — verified by `aiJobs.model.test.js` against real MySQL. This is the compensating control for the in-process-only lock.
- **Verdict:** PARTIALLY IMPLEMENTED — architecture solid and tested, but dead in the current config because its first stage (analysis) is disabled.

---

## 16. AI Registry / Provider Seam

- `aiRegistry.service.js` — extensible registry, capability lookup by name. Current members: `catalogRecommendationProvider`, `hfSchemeProvider`. Explicitly **not** `mockProvider`.
- This is a clean seam; adding an analysis provider (e.g., re-introducing http-vision or a new HF vision model) is the intended extension point.
- **Verdict:** seam FULLY IMPLEMENTED; **provisioning empty** for analysis → the registry is the exact place a future provider plugs in.

---

## 17. Rendering Engine (canvas pipeline)

| Component | Verdict |
|---|---|
| Konva compositing (LayerNode stack, asset image + recolor layers) | FULLY |
| `colorEngine.js` — LAB-space recolor, applyPaintColor | FULLY (tested) |
| `maskOps.js` — flood-fill, alpha contract (0–255 = selection strength), house-mask gating `canEnterFloodFillPixel` | FULLY (tested) |
| Brush/magic-wand/lasso/rect/polygon creation via `CREATED_VIA_VALUES` | FULLY |
| Mask persistence (multipart PATCH, `uploads/<assetId>/` wrapper) | FULLY |
| Opacity / finish inputs (AdjustmentsTab) | PARTIALLY — opacity fully applied; **finish_override is metadata-only, never rendered** (§29) |

---

## 18. Undo / Redo

- `useHistoryCommand` — command pattern with optimistic updates + rollback on failure; `undo_pointer` persisted per project (`/undo-pointer`); backend `history` table is an append-only log.
- **Verdict:** FULLY IMPLEMENTED. Note DOCUMENTATION §10.2 H-10: history is unbounded (no cap/compaction) — still true (Low).

---

## 19. Persistence Strategy

| Layer | Tech | Verdict |
|---|---|---|
| Server truth | MySQL (projects/assets/layers/paints/etc.) | FULLY |
| Draft recovery | IndexedDB via idb-keyval | FULLY |
| Favorites/collections | localStorage | FULLY |
| Server cache for catalog list | client-side (pageSize 2000 cached in visualizer; catalog pages use 24/page) | FULLY |

---

## 20. Excel Import / Export

- `excelImport.service.js` — preview/commit; action classification create/update/**revive** (soft-deleted rows are matched via `findByColorCode({includeDeleted})` and revived by `update()` which forces `is_deleted=0`).
- **Transactional integrity fixed:** model methods accept an `executor` param; `commitImport` passes its transaction connection, so mid-import failures roll back the whole batch (was previously P0 — only import_log was transactional). Verified by test.
- `EXCEL_COLUMN_MAP` drops source `id` in favor of `s_id` (avoids trusting client ids).
- Magic-byte `.xlsx` check closes the silent-empty-workbook gap.
- Export: XLSX blob through the header-authenticated client (no raw link 401).
- **Verdict:** FULLY IMPLEMENTED, tested (excelImport.service.test.js).

---

## 21. Upload Pipeline & Validation

- Multer (memory) → `uploadValidation`: mimetype allow-list **plus** magic-byte `isRealImage`; header-dimension `MAX_IMAGE_DIMENSION=8000px` decompression-bomb guard before any decode/write; WEBP fallback.
- Stored id-keyed under `UPLOAD_ROOT` with **`original.jpg` constant filename** — `exif_orientation` never read (dead column, F-12).
- File-name path-traversal: neutralized — filenames are server-assigned (`original.jpg`, `cleaned.jpg`), and `storage.service.js` has a path-relative containment guard (fixes prior P2).
- Rate-limited 20/15-min at upload + import routes.
- **Verdict:** FULLY IMPLEMENTED (one of the strongest parts of the codebase).

---

## 22. Storage Service

- `fs/promises` (async — prior sync H-08 fixed).
- `removeTree` for delete cleanup of both photo dir `<assetId>/` and mask wrapper `uploads/<assetId>/` (prior orphan-UUID bug fixed).
- **Containment guard:** relative-path check (closes prefix-containment bypass that could reach sibling dirs).
- **Verdict:** FULLY IMPLEMENTED, tested (storage.service.test.js).

---

## 23. Error Handling & Logging

- `logger.service.js` — structured JSON logs, 5MB rotation.
- `errorHandler` — logs stack server-side, returns `err.message` (client-visible; Low info-leak, F-09).
- `requestId` middleware + frontend correlation (X-Request-Id logged client-side on failures).
- `httpClient` — 30s default timeout, retry 429/503/504 (max 2, exp backoff 500ms→4s), `ProviderError`.
- `aiProxy` — dispatcher for clipdrop/huggingface, magic-byte validation of HF response w/ PNG fallback.
- **Verdict:** FULLY IMPLEMENTED overall; exception noted in F-09.

---

## 24. Rate Limiting & DoS Posture

| Path | Limit | Verdict |
|---|---|---|
| `/api/projects/:projectId/assets` (upload) | 20 req / 15 min | FULLY |
| `/api/catalog/import` | 20 req / 15 min | FULLY |
| `/api/assets/:id/clean` | covered by generic upload limiter (same route family) | PARTIALLY — no per-asset dedupe; a client with the key can spam expensive model calls within the window (Low, F-10) |
| Everything else | **no limit** | by design (single-user tool) |

---

## 25. Security Findings Register

| ID | Finding | Class | Severity |
|---|---|---|---|
| F-03 | API key fail-open when unset/unchanged (`keyNotConfigured`) | Auth | Medium |
| F-04 | `/files/*` + `?key=` symmetric with API key; without key config, files public | Auth | Medium |
| F-05 | Secrets at rest (HF/ClipDrop/DB/dev-key) in untracked `.env` | Secrets | Medium |
| F-07 | `/api/catalog` `pageSize` unbounded → `LIMIT ?` (parameterized, not injectable, but large-result/DoS via a single request) | Perf/DoS | Low |
| F-08 | `listProjects` unpaginated (full table each call) | Perf | Low |
| F-09 | `err.message` returned to client (may leak internal paths/provider details) | Info-leak | Low |
| F-10 | No per-asset dedupe/lock on `/clean` (expensive inference, shared key) | DoS | Low |
| F-15 | No CSRF protection on state-changing endpoints | Web | Low (key-gated; would require key theft anyway) |
| F-16 | Upload memory buffering (multer memory storage, 25MB cap) — large concurrent uploads could exhaust memory | DoS | Low |
| F-17 | Compose default creds (`root_change_me`) | Hardcoded creds | Low (compose-only) |

---

## 26. Correctness & Data-Integrity Findings

| ID | Finding | Class | Severity |
|---|---|---|---|
| F-11 | Pipeline lock in-memory `Set` — single-process only; DB constraint compensates | Concurrency | Info |
| F-18 | Layer delete cascades asset/layer-file cleanup; project delete cascades assets (best-effort disk cleanup, DB first) | Integrity | Info |
| F-19 | `removalQuality` unverifiable results pass through by design (documented trade-off) | Correctness | Info |
| F-20 | Optimistic concurrency: `updatedAt` check on project PATCH — DOCUMENTATION marks it **inert** (still true; not enforced by DB) | Integrity | Low |
| F-21 | Mask file accumulation over edits — DOCUMENTATION P2 still open (each mask edit writes a new file; no GC) | Storage | Low |

---

## 27. Placeholder / Stub / Mock Inventory

| Item | Location | Class |
|---|---|---|
| Server-side PDF export | `exports` route → 501 | **STUB** (explicitly deferred; client renders PNG/JPG only) |
| `mockProvider` (analysis heuristic) | `ai/ai.mockProvider.js` | **MOCKED** (unregistered, test-only, safe to delete) |
| `finish_override` (paint finish) | AdjustmentsTab metadata only | **PLACEHOLDER** (input exists; no render path) |
| `exif_orientation` | schema column | **DEAD** (never read/written) |
| AI recommendation providers (real) | hfSchemeProvider | FULLY (not placeholder) |
| House-understanding analysis | — | **UNIMPLEMENTED in current tree** (provider deleted, registry empty) |

---

## 28. Documentation vs Reality (drift table)

| # | Doc claim (file:line) | Reality in working tree | Class |
|---|---|---|---|
| 1 | README:32 "house understanding … default mock provider, in-process" | mock unregistered; **no provider**; analysis disabled | **STALE** |
| 2 | README:62 "AI House Understanding … ✅ working (mock provider; http-vision drop-in)" | both providers deleted | **STALE** |
| 3 | README:65–74 "AI on by default, no key needed … zero API keys, zero network calls" | flag off; keys required for the one live feature (cleanup) | **STALE** |
| 4 | README:91 "cp .env.example .env … house understanding + schemes work out of the box" | `.env.example` ships `AI_ANALYSIS_ENABLED=false`; no provider | **STALE** |
| 5 | README:107–109 "Test the house-understanding flow end-to-end … works out of the box on the mock provider" | no mock provider; test can't run | **STALE** |
| 6 | DOCUMENTATION §7 "Two AI capabilities ship with provider-less defaults … House Understanding uses the mock provider" | mock removed; disabled | **STALE** |
| 7 | DOCUMENTATION §7.1 mock/http-vision descriptions | files deleted | **STALE** |
| 8 | DOCUMENTATION §7.4 `AI_ANALYSIS_PROVIDER=mock` / `AI_ANALYSIS_ENABLED=true` | `.env.example` now `false`; compose still `mock` (F-06) | **STALE** |
| 9 | DOCUMENTATION §7.6 local vision service | `backend/vision-service/` deleted | **STALE** |
| 10 | DOCUMENTATION §8 "AI House Understanding … ✅ working (mock provider; http-vision drop-in)" | not runnable | **STALE** |
| 11 | DOCUMENTATION §9.4 "House understanding: Placeholder (mock heuristic)" | now disabled/empty — worse than placeholder | **STALE** |
| 12 | DOCUMENTATION §10.1 bundle "0.90 MB total (JS 0.87 MB)" | `frontend/dist` measured **0.92 MB, 3 files** (JS-only file now larger; needs re-verify) | **MINOR DRIFT** |
| 13 | DOCUMENTATION §11.2 dead chains (activeColor, compareMode, inProgressMaskCanvas, useUpdateProject, exif_orientation, finish_override) | **confirmed still dead** in current tree | **STILL TRUE** |
| 14 | docs/AI_VISUALIZER_FINAL_IMPLEMENTATION_REPORT.md (mock live default) | outdated for the same reasons | **STALE** |

Verified fixed (docs P0/P1 items now resolved in code): Excel import transaction (P0), soft-delete crash on re-import (P1), storage path guard (P2), `/files` open access (P0), catalog-export link 401 (P1), cleanup rate-limit (P2), upload validation (P2), HTTP timeouts (H-06), sync fs (H-08), request-id (H-09 partial). Still open from docs' own lists: F-03, F-07, F-08, F-09, F-10, F-20, F-21, H-10.

---

## 29. Dead Code & Unused Inventory

Confirmed still-present (grep + read):
- `App.jsx` → `onColorFocus` prop passed to `Sidebar.jsx` which declares **no props** (dead chain: CatalogPage/VisualizerWorkspace wiring goes nowhere) — same as DOCUMENTATION §11.2.
- `useUpdateProject` (`useProjects.js:27`) — **zero call sites** (only `useSetUndoPointer` used).
- `exif_orientation` DB column.
- `finish_override` metadata (AdjustmentsTab finish input has no render path).
- `inProgressMaskCanvas`, `activeColor`, `compareMode` remnants (documented as dead; confirmed by reads).
- `reconcileUploads.js` — utility script (kept; harmless).

Deleted-but-documented (not dead — intentionally removed): visionAssembly, http/hf vision providers, `backend/vision-service/`, smokeVisionAssembly, mockProvider registration.

---

## 30. Broken Features

| Item | Detail | Class |
|---|---|---|
| compose AI default | `docker-compose.yml:37` `AI_ANALYSIS_PROVIDER:-mock` — would pass an **unregistered** provider id to the app if compose used with defaults → analysis route would fail | **BROKEN (compose-only)** |
| (none in the primary code path) | All primary CRUD + canvas + upload + import + removal paths verified working via tests | — |

---

## 31. Duplicated / Conflicting Logic

| Item | Detail |
|---|---|
| `original.jpg`/`cleaned.jpg` naming conventions appear in storage.model + controller comments consistently | consistent, no drift |
| Masks stored under two disjoint real locations (`<assetId>/` vs `uploads/<assetId>/`) | **DUPLICATED layout** — deliberate (documented in assets.controller deleteAsset comment) but a known foot-gun; deleteAsset handles both |
| `AI_ANALYSIS_PROVIDER` referenced in `aiConfig`, `aiRegistry`, compose, README, DOCUMENTATION with 3 different default narratives | conflicting docs (see §28) |
| Provider-env naming: `AI_PROVIDER=huggingface` (cleanup) vs `AI_ANALYSIS_PROVIDER` (analysis) vs `AI_RECOMMENDATION_PROVIDER` (schemes) — three separate env namespaces | easy to misconfigure; source of the current env's dead config |

---

## 32. Performance Hotspots

| # | Hotspot | Assessment |
|---|---|---|
| P-1 | `paints.list` unbounded `pageSize` (LIMIT ? from client) | Low-Medium (F-07) |
| P-2 | `listProjects` unpaginated | Low (F-08) |
| P-3 | Canvas full-image pixel loops (`getImageData`) per brush stroke at 8000px images | Medium — mitigated by 8000px cap + selection-strength writes; larger than typical |
| P-4 | Cleanup = remote inference (FLUX.2 edit) with 60s client timeout | Medium — functional but slow; no queue, in-request |
| P-5 | Catalog page loads 24/pg (fine); visualizer loads 2000 cached | Info |
| P-6 | 785 files / 30.7 MB mask accumulation under nested `backend/uploads/uploads/` | Low (F-21) |

---

## 33. Test Suite Assessment

| Suite | Count | Coverage signal |
|---|---|---|
| Backend | 76 pass | middleware (upload validation), DB constraint (aiJobs), pipeline stages, locks, catalog + hf scheme providers, removal quality, surface quality, classification, Excel import, logger, projects, storage |
| Frontend | 41 pass | colorEngine, maskOps (incl. flood-fill house-mask gating), color/layer ownership, state |

**Gaps:** no E2E (Playwright/Cypress); no integration test exercising the full `/ai/process` HTTP path with a provider (none exists to run); no contract test against a real HF endpoint; no load/perf tests. CI absent → tests only run manually.

---

## 34. Risk Register (prioritized)

| Priority | Risk | Impact | Likelihood | Mitigation status |
|---|---|---|---|---|
| 1 | Docs claim AI works OOB; it doesn't (F-01/F-02) | User/dev trust; wasted debugging | Certain | Update docs + `.env.example` + README |
| 2 | Fail-open auth + shared key (F-03/F-04) | Full compromise if deployed exposed | Medium (dev tool) | Set real key + restrict `/files` or add auth to it |
| 3 | Secrets at rest (F-05) | Exposure if repo/machine shared | Low-Medium | Rotate keys; enforce ignore; add secret scanning |
| 4 | No analysis provider (F-01) | Flag feature unusable | Certain | Re-register a provider or document status |
| 5 | Compose AI default broken (F-06) | `docker compose up` analysis breaks | Medium | Change default to `none` |
| 6 | pageSize/listing unbounded (F-07/F-08) | Perf/DoS on big catalogs | Low | Clamp pageSize; paginate projects |
| 7 | err.message leak (F-09) | Internal info disclosure | Low | Return generic error body |
| 8 | Cleanup spam (F-10) | Cost abuse via shared key | Low | Per-asset in-flight guard |
| 9 | History unbounded (H-10), masks accumulate (F-21) | Storage growth | Low | GC/compaction policy |

---

## 35. DevOps & CI Analysis

- **No CI pipeline, no lint step, no coverage gate.** Tests are manual (`npm test`). Recommend adding a CI job running both suites + a secrets scan.
- Dev loop: nodemon backend; Vite dev frontend (no proxy — direct to :4000; CORS allows `http://localhost:5173`).
- `docker-compose.yml` stands up MySQL 8.0 with schema init; backend/frontend containerized; frontend Dockerfile runs the **dev server** (`npm run dev -- --host`), not a static build (production deployment would need `vite build` + static host).

---

## 36. Docker / Compose Analysis

| Item | Assessment |
|---|---|
| MySQL 8.0 + mounted `schema.sql` initdb | FULLY |
| Backend Dockerfile (node:20-alpine, `--omit=dev`, CMD server.js) | FULLY |
| Frontend Dockerfile (dev server, not built) | PARTIALLY — not production-ready as-is |
| Compose env defaults | **Contains `AI_ANALYSIS_PROVIDER=mock` (F-06)**; hardcoded DB creds; passes host env keys through `HF_API_KEY`/`CLIPDROP_API_KEY` |
| Volumes | uploads under `/data/uploads` |

---

## 37. Dependency & Supply-Chain Notes

- Backend: Express 4.19.2, mysql2 3.10, jimp, xlsx 0.18.5, multer, helmet, cors, express-rate-limit 7.2, zod 3.23, uuid, dotenv — all pinned ranges; **no audit/`npm audit` run in CI** (none exists). xlsx has known prototype-pollution advisories in older 0.18.x — recommend `npm audit` and upgrade if flagged.
- Frontend: pinned ranges; no audit gate.
- No lockfile analysis performed (UNKNOWN for exact resolved versions).

---

## 38. Feature Completeness Matrix (vs README/requirements claims)

| Feature | Claimed | Actual (current tree) | Class |
|---|---|---|---|
| Upload + cover thumbnail | Yes | Yes | FULLY |
| Layer creation (brush/magic-wand/lasso/rect/polygon) | Yes | Yes | FULLY |
| Recolor + opacity + export (PNG/JPG, side-by-side) | Yes | Yes | FULLY |
| PDF export | Deferred | 501 stub | STUB |
| Undo/redo + persistence | Yes | Yes | FULLY |
| Excel import/export (preview/commit/revive) | Yes | Yes | FULLY |
| House understanding | Yes (OOB mock) | **Disabled + no provider** | PARTIALLY (dead-in-config) |
| Autonomous AI pipeline | Yes | Built + tested; disabled in env | PARTIALLY (dead-in-config) |
| Paint recommendations | Yes (catalog default) | Built; hf-scheme active but blocked by analysis | PARTIALLY (dead-in-config) |
| Object removal (cleanup) | Yes | Yes (only live AI path) | FULLY |
| House-damage guard on cleanup | Yes | Yes (quality gate) | FULLY |
| Catalog favorites/collections | Yes | Yes (localStorage) | FULLY |
| Draft recovery | Yes | Yes (IndexedDB) | FULLY |
| Auth | Dev key | Fail-open shared key | PARTIALLY |

---

## 39. Verification Artifacts (commands run)

```
git log --oneline --all --decorate
git status / git ls-files
npm test          (backend)  → 76 pass / 0 fail
npm test          (frontend) → 41 pass / 0 fail
Read: app.js, server.js, config/db.js, config/aiConfig.js, aiRegistry.service.js,
      mockProvider.js, catalogRecommendationProvider.js, hfSchemeProvider.js,
      houseUnderstanding.service.js, paintRecommendation.service.js, aiPipeline.service.js,
      objectRemovalMask.service.js, removalQuality.service.js, surfaceQuality.service.js,
      objectClassification.js, inFlightLock.service.js, aiProxy.service.js,
      httpClient.js, storage.service.js, excelImport.service.js, paints.model.js,
      assets.model.js, layers.model.js, aiJobs.model.js, projects.model.js,
      paints.controller.js, assets.controller.js, importExport.controller.js,
      accessKey.middleware.js, errorHandler.middleware.js, requestId.middleware.js,
      uploadValidation.middleware.js, runSchema.js, reconcileUploads.js,
      all route files, docker-compose.yml, both Dockerfiles, both package.json,
      both .env.example, frontend api.js, vite.config.js, plus frontend feature files
      and tests (via subagent + direct reads).
Grep: TODO|FIXME|XXX|HACK|placeholder|not implemented across JS → benign only.
Env inspection: backend/.env, frontend/.env (values redacted).
Inventory: backend/uploads (797 files / 36.1 MB; nested legacy dir 785 files / 30.7 MB),
           frontend/dist (3 files / 0.92 MB).
```

---

## 40. Remediation Recommendations (report-only — no code changed)

**Immediate (docs/ops):**
1. Fix README + DOCUMENTATION + final-implementation-report to describe the *current* tree: analysis disabled by default, no registered analysis provider, cleanup is the only live AI feature, recommendations blocked until analysis exists.
2. Change `docker-compose.yml` AI default from `mock` to `none`/empty (F-06).
3. Decide the product stance: (a) re-register an analysis provider (http-vision/hf-vision restore or new), or (b) formally declare house-understanding & recommendations as "coming soon" and adjust docs/UI accordingly.

**Short-term (code quality, low risk):**
4. Clamp `pageSize` in `paints.list`; paginate `listProjects` (F-07/F-08).
5. Return a generic body from `errorHandler` (log details server-side) (F-09).
6. Add per-asset in-flight guard for `/clean` (F-10).

**Medium-term (hardening):**
7. Enforce non-default API key at startup (fail-closed warning mode) and restrict `/files` auth to header-only or signed URLs (F-03/F-04).
8. Rotate HF/ClipDrop keys, add CI secrets scan, run `npm audit` and upgrade `xlsx` if flagged.
9. Delete dead chains from §29 (activeColor/onColorFocus, useUpdateProject, exif_orientation, finish_override) — docs already call them out.
10. Add CI: both test suites + lint + secrets scan; add E2E smoke test for the visualizer loop.

**Long-term (architecture):**
11. Replace in-memory pipeline lock reliance with DB-backed claims (already partially done via `uq_ai_jobs_running`) and add a queue/worker for cleanup inference (P-4).
12. Introduce mask-file GC and history compaction (F-21/H-10).

---

## 41. Verdict

**The application is in good engineering health for its core product loop** — upload → layers → recolor → export, plus Excel catalog management, are fully implemented, well-guarded (magic-byte validation, dimension caps, transactional import, path containment), and backed by 117 passing tests.

**The AI strategy is half-implemented and mis-documented.** The infrastructure (registry, pipeline, locks, quality gates, schemas) is real and well-built, but the flagship capability — house understanding and the recommendations that depend on it — has **no provider and is disabled** in the current working configuration, while the documentation still advertises a mock provider that ships "out of the box." This is the single most important discrepancy a reader must know: **the docs describe a previous state of the code.**

**Security is acceptable for a single-user local tool but not for exposure**: fail-open auth, a shared key in build config, secrets at rest, and `/files` access-by-key are the main items to address before any remote deployment.

**Overall classification: PARTIALLY IMPLEMENTED** for the AI suite; **FULLY IMPLEMENTED** for the core product; **BROKEN** in exactly one default configuration (compose `AI_ANALYSIS_PROVIDER=mock`); **STALE** documentation in 14 verified places.
