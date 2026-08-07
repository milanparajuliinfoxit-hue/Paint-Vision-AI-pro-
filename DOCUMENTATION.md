# Paint Dealer Visualizer — Comprehensive Project Documentation

> **Consolidated reference.** This single document replaces the previous cluster of
> README/spec/audit/report markdown files. It is the product spec, architecture guide,
> API reference, AI pipeline docs, audit findings, performance report, and improvement
> roadmap for the project — all in one place.

**Versions covered:** v1 (four-step wizard scaffold, no persistence) → v2 (project-centric,
layer-based, persistent platform) → v2 AI features (house understanding + paint
recommendations). Latest audit date: 2026-08-05. Repo root:
`C:\Users\Lenovo\Downloads\paint-visualizer (1)\paint-visualizer`.

---

## Table of contents

1. [Overview](#1-overview)
2. [Architecture & stack](#2-architecture--stack)
3. [Data model](#3-data-model)
4. [Running it locally](#4-running-it-locally)
5. [Product & engineering specification](#5-product--engineering-specification)
6. [API reference & flows](#6-api-reference--flows)
7. [AI features](#7-ai-features)
8. [Implementation status](#8-implementation-status)
9. [Audit findings & risk register](#9-audit-findings--risk-register)
10. [Performance report](#10-performance-report)
11. [Placeholder & deferred inventory](#11-placeholder--deferred-inventory)
12. [Improvement roadmap](#12-improvement-roadmap)
13. [Appendix — source documents](#13-appendix--source-documents)

---

## 1. Overview

A project-centric AI visualization platform for paint dealers: a persistent, layer-based
photo workspace where a dealer masks surfaces, tries catalog colors in real time, and
exports a client-ready comparison — nothing is lost on refresh. It supersedes the v1
scaffold (single-page 4-step wizard, no persistence).

**Current state (v1):** single-page, four-step linear wizard (Upload → Clean up → Select
surface → Apply color) with no project concept, no persistence, a flat 30-swatch color grid,
and a manual brush-then-apply flow. Nothing survives a refresh.

**Target state (v2):** a project-centric AI visualization platform for paint dealers,
structurally comparable to Figma/Canva for the canvas experience and to a lightweight CRM
for the business-record side.

**Status verdict (2026-08):** a well-crafted, pre-release scaffold with a genuinely working
core — not yet a shippable product. Production readiness scored ~3.4/10 across audits. The
core painting loop is real and polished; the AI "house understanding" runs on a
heuristic mock by default (swappable via config to a real model); business features
(identity, segmentation, finish physics, reporting) are deferred.

---

## 2. Architecture & stack

```
frontend (React/Vite, Konva canvas)  ──HTTP──▶  backend (Express)  ──HTTP──▶  hosted AI API (cleanup / vision)
        │                                            │
   layer compositing,                          MySQL (catalog, projects,
   client-side LAB recolor                     assets, layers, history,
   (no server round trip)                      concepts, exports,
                                               ai_jobs, detected_surfaces,
                                               detected_objects,
                                               paint_recommendations)
                                                   + local /uploads
```

- **Client does the image work:** applying a catalog color to a masked surface runs in the
  browser on `<canvas>` using a LAB-color-space blend (`frontend/src/shared/lib/colorEngine.js`)
  that preserves the photo's shading/texture. Each `Layer` composites independently (Konva),
  so changing one layer's color re-renders only that layer. **`colorEngine.applyPaintColor`
  is the only paint path in the app** — live canvas, previews, and exports all derive from it.
- **Server = storage + AI understanding + thin proxies:** plain CRUD backed by MySQL plus
  local-disk file storage, plus two AI capabilities (house understanding → detected
  surfaces/objects + masks, default `mock` provider, in-process; catalog-scored paint schemes).
  The AI only produces structured understanding; applying paint always goes through the
  existing layer/recolor pipeline. A separate hosted proxy (`POST /api/assets/:id/clean`)
  forwards to Clipdrop/Hugging Face for cleanup.
- **No auth/RBAC** — single-editor, no login, matching v1's model (explicit product decision
  for this phase; see §5.10 for the deferred role model). Only a shared `x-api-key` guard.

### 2.1 Stack

| Layer | Technology |
|---|---|
| Frontend | React 18.3, Vite 5, Konva 10 / react-konva 18, Tailwind 4, shadcn/ui + Radix primitives, framer-motion, lucide-react, TanStack Query v5, Zustand 5, idb-keyval, react-router 6 |
| Backend | Node ≥18 (uses `fetch`/`FormData`/`Blob`), Express 4.19, mysql2 pool, multer, xlsx, zod, helmet, cors, express-rate-limit, jimp (AI heuristics), uuid, morgan |
| Database | MySQL 8/9 (`paint_visualizer_pro`, user `paint_app`) |
| Storage | Local disk `./uploads` behind `storage.service.js` (single S3/MinIO swap point) |
| AI removal providers | Clipdrop (`x-api-key`) or Hugging Face Inference Providers router (Bearer token) |
| AI understanding providers | `mock` (default, Jimp heuristics) or `http-vision` (BYO model, same JSON contract) |

### 2.2 State ownership rules (spec §11, verified in code)

- **TanStack Query owns all server state** (projects, catalog, history reads, export job polling).
- **Zustand owns ephemeral/local editor state** (active tool, canvas viewport, in-progress mask, undo stack pointer).
- **IndexedDB** (`idb-keyval`) caches the per-project draft (viewport/tool/active ids), debounced 400 ms.
- **localStorage** holds per-browser favorites / recently-used (last 8) / collections (no auth).

### 2.3 Responsive behavior

- Full three-pane layout ≥1280px; left sidebar collapses to an icon rail and right inspector
  to a slide-over sheet at 768–1279px; **<768px the Visualizer is read/compare-only** with a
  visible notice (an intentional spec constraint, not a bug).

### 2.4 Key engineering invariants

1. `colorEngine.applyPaintColor` is the only thing that paints the image (renderer invariant).
2. AI providers produce structured understanding only — they never paint.
3. AI layer idempotency: unique key `(ai_analysis_id, ai_surface_key)` + server-side upsert
   (201 new / 200 in-place update, never duplicates).
4. Masks are alpha PNG files on disk, never inline pixels in app state.
5. All storage writes go through `storage.service.js`.
6. Every AI provider swap is a **config change** (capability registry + standardized result envelope).

---

## 3. Data model

Full schema: `backend/src/sql/schema.sql` (additive/idempotent; `npm run migrate` is safe to
re-run). `runSchema.js` substitutes `DB_NAME` from `.env` at apply time.

```
Project
  id, name, clientName, status ('draft'|'in_review'|'client_approved'|'archived'),
  coverAssetId, tags[], reference_note, createdAt, updatedAt (TIMESTAMP(3), ms precision)

Asset               // an uploaded photo and its derived states
  id (UUID == on-disk folder), projectId (FK ON DELETE SET NULL), kind: 'original'|'cleaned'
  original_path, cleaned_path, status enum, error_message, exif_orientation, createdAt

Layer               // one per paintable surface region within an asset
  id, assetId, projectId, name, maskPath (alpha PNG file)
  createdVia: 'brush'|'magic-wand'|'lasso'|'rect'|'polygon'|'ai-surface'
  currentColorId (FK → paints, ON DELETE SET NULL), opacity, finishOverride, orderIndex,
  locked, visible, deleted_at (soft delete so undo restores same id/mask),
  aiSurfaceKey, aiAnalysisId, aiSchemeId, UNIQUE(ai_analysis_id, ai_surface_key)

PaintColor          // catalog entry (org-scoped in concept; single global today)
  id, sku, color_code (UNIQUE), name, brand, finish, r/g/b, generated hex_value,
  lrv, isFavorite (per-user), lastUsedAt, 7 product-line booleans, is_deleted

HistoryEntry        // append-only undo/redo log
  id, projectId (FK CASCADE), timestamp, action, before_state/after_state JSON

Concept             // a saved "look" — named snapshot of layer/color state
  id, projectId (FK CASCADE), name, thumbnail_path, layer_color_map JSON

ExportJob
  id, projectId (FK CASCADE), format ENUM('pdf','png','side-by-side-jpg'),
  comparison_mode ENUM('side-by-side','slider','split','fade'),
  status 'pending'|'ready'|'failed', fileRef, updated_at(3)

ai_jobs             // versioned audit log per AI run
  id, assetId (FK CASCADE), job_type, provider, status, confidence,
  processing_time_ms, model_version, output_json, failure_reason

detected_surfaces / detected_objects
  id, analysis_id (FK → ai_jobs), assetId, class_key, display_name, paintable,
  mask_path, confidence, geometry, average_color, role

paint_recommendations
  id, analysis_id, paint_id, role, scheme_json, status 'draft'|'applied',
  tagline, rationale JSON

import_log          // append-only Excel import audit (rows_new/updated/skipped/error)
```

Design highlights:
- **Masks are files, not rows** — compressed alpha PNGs keep undo snapshots and API payloads cheap.
- **Generated `hex_value`** keeps the frontend catalog row honest — hex can never drift from r/g/b.
- **`updated_at TIMESTAMP(3)`** exists specifically so same-second optimistic-concurrency
  PATCH conflict checks are distinguishable (409 on mismatch).
- **`cover_asset_id`** is auto-set on first photo upload so project cards render thumbnails
  without extra fetches.
- v1 tables `visualization_jobs`/`job_results` were dropped in v2 (`schema.sql:59-60`).
- Known denormalization: `layers` reference both `asset_id` and `project_id` (convenient for
  queries; worth a consistency check in future migrations).

---

## 4. Running it locally

```bash
# 1. Start MySQL (or use docker-compose for everything)
docker compose up -d mysql

# 2. Backend
cd backend
cp .env.example .env      # fill in DB + AI keys (house understanding + schemes work out of the box on the mock/catalog providers)
npm install
npm run migrate           # applies schema.sql (safe to re-run — additive/idempotent)
npm run dev               # http://localhost:4000

# 3. Frontend
cd frontend
cp .env.example .env
npm install
npm run dev               # http://localhost:5173
```

Or everything at once: `docker compose up --build` from the project root.

**Notes on the local dev environment (verified during audit):** MySQL 9.6 service `MySQL96`;
DB `paint_visualizer_pro`, user `paint_app`/`change-me`; both `.env` files share
`API_ACCESS_KEY=pv-local-dev-key-2026`. Docker is **not** installed on this machine. The
compose file itself uses DB name `paint_visualizer` (drift vs. local `paint_visualizer_pro`;
works because `runSchema.js` substitutes `DB_NAME`).

---

## 5. Product & engineering specification

### 5.1 Product vision & non-goals

**Vision:** a dealer opens the app, sees their book of client projects, opens one, and gets a
persistent, undo-capable, multi-layer photo workspace where they can mask surfaces, try catalog
colors in real time, generate AI suggestions, and export a client-ready comparison — without
losing work on refresh, tab close, or crash.

**Explicit non-goals for v2 (scope guard):**
- No multi-user real-time co-editing (single editor per project; data model designed so it *could* support it later, but no presence/CRDT sync now).
- No native mobile app — responsive web only, with a reduced-capability tablet/touch mode.
- No custom paint-mixing/spectrophotometer integration in this phase.
- No offline-first guarantee beyond draft autosave — full offline mode is a future phase.
- No RBAC/roles; no Reports (depends on cross-rep aggregation that needs roles); no PDF export
  with dealer branding (returns an explicit 501, not a silent downgrade).

### 5.2 Personas

1. **Dealer Rep (primary):** visits client homes, takes photos, generates visualizations on a laptop/tablet. Needs speed and low friction more than deep photo-editing power.
2. **Store Manager:** reviews projects across reps, checks catalog usage, pulls reports. Needs Dashboard and Reports, rarely touches the Visualizer.
3. **Admin:** manages the paint catalog (SKUs, brands, finishes, pricing), user roles, brand/store settings.

### 5.3 Information architecture

Top-level nav (persistent left rail, collapsible): **Dashboard** (recent projects, quick-create,
usage stats, continue-where-you-left-off) · **Projects** (searchable/filterable by client, status,
date, rep; grid/table toggle; statuses Draft/In Review/Client Approved/Archived) · **Paint Catalog**
(searchable card library, admin-editable if role permits) · **Visualizer** (opens *only* in the
context of a project — route `/projects/:projectId/visualize`; landing on `/visualize` with no
project redirects to a "new project" creation modal) · **Reports** (deferred) · **Settings** (deferred).

### 5.4 Visualizer workspace

- **Center canvas:** Konva `Stage`, pan (space+drag / two-finger), zoom (ctrl/cmd+scroll, pinch,
  persistent zoom control with fit-to-screen and 100%), fullscreen toggle (spec; currently missing in code).
- **Left sidebar (tabbed):** Assets · Layers (reorderable, visibility/lock toggles, per-layer color
  swatch) · History (scrubbable "peek") · AI Suggestions · AI Understand · AI Schemes.
- **Right inspector (contextual):** paint catalog panel, brush options (size/hardness/opacity —
  hardness slider is spec, currently missing), surface properties (name, finish override).
- **Floating toolbar:** Selection tools (Magic Wand, Lasso, Rectangle, Polygon, AI Surface Selection)
  → Paint tools (Brush, Spray, Bucket Fill) → Utility (Eyedropper, Pan/Hand, Zoom). Keyboard
  shortcuts `r l g m b e i h` (Spray is spec, currently missing).

### 5.5 Tool behavior & masking architecture

- Every selection tool produces a **mask**, not an immediate paint action. The mask becomes a new `Layer`.
- **Bucket Fill** applies color directly to an existing selected mask/layer.
- **Brush/Spray** has two explicit modes: *mask-editing* (refine an existing layer's mask,
  add/subtract via alt-key or toggle) and *direct-paint* (freehand color, auto-generating a layer).
- **AI Surface Selection** calls the backend segmentation endpoint and returns candidate surface
  masks (wall, trim, roof, door); each becomes a `Layer` with `createdVia: 'ai-surface'`.
- **Live painting** is implemented via Konva `Group` compositing — each layer is a shape with a
  mask and a fill color bound to Zustand state; changing `currentColorId` re-renders only that layer.
- Masks are stored as compressed alpha PNGs referenced by URL/blob (not inline base64 in app state).

### 5.6 Undo/redo

Implemented as a **command pattern** (not full-state snapshots): each `HistoryEntry` stores enough
to invert the action (patch/create/delete/bulk-delete types: color-applied, opacity-changed,
visibility-changed, lock-changed, order-changed, mask-edited, name-changed, finish-changed,
mask-created, layer-deleted, paint-cleared). Persisted per project so the stack survives refresh;
hydrated on load; `jumpTo` replays for history scrubbing.

### 5.7 Paint catalog

Cards show color preview, name, SKU, finish, brand, favorite toggle (per-user, persisted),
recently-used rail (last 8), and search/filter by name, SKU, brand, finish, hex-proximity.
**Instant hover preview** applies the color to the currently active layer at <100ms latency
without committing; commit only on click (rAF-coalesced recompute). Layer-aware AI suggestions
sample **outside** the active layer's actual mask and suggest per-surface ("wall: warm greige,
trim: soft white") rather than one flat palette.

### 5.8 Persistence strategy

- **Source of truth:** backend; all entities persisted server-side.
- **Autosave:** debounce local edits (400ms IndexedDB draft; server-side PATCH) with a subtle
  "Saved / Saving… / Unsaved changes — retrying" indicator — never a blocking save action.
- **Local draft cache:** IndexedDB mirror keyed by `projectId` so a refresh mid-edit restores instantly.
- **Conflict handling:** last-write-wins for single-editor scope; PATCH includes an `updatedAt`
  check (409) with a non-blocking conflict toast. *(Audit note: the server-side 409 checks exist
  but no UI caller currently passes `updatedAt` — the toast is unreachable until wired.)*
- **What survives a refresh:** original + cleaned image, all layers with masks and assigned
  colors, undo history, saved Concepts, active tool/inspector state.

### 5.9 Comparison & export

- Modes: **Original / Cleaned / Painted** states; **Side-by-side**, **Slider**, **Split view**,
  **Fade transition** as display modes for comparing any two states (including two Concepts).
- Export: **PNG** and **side-by-side JPG** work (client-side composite re-render, uploaded as an
  `ExportJob`). **PDF → explicit 501** (needs a server render pipeline with dealer branding — deferred).
  Export should run as an async job with visible progress so the user can keep editing (currently
  synchronous; the modal dialog is modal — aspirational wording in the UI).

### 5.10 Roles & permissions (deferred, spec)

- **Rep:** create/edit own projects, use Visualizer, export.
- **Manager:** everything a Rep can do across all reps' projects, plus Reports.
- **Admin:** everything above, plus Paint Catalog management and Settings.
- Gate nav items **and API calls** server-side — not just hidden UI.

### 5.11 Accessibility & responsive requirements

- Full keyboard access to toolbar, inspector, catalog search (single-letter tool shortcuts,
  arrow-key card navigation, Enter to apply). Canvas painting itself is pointer-first.
- ARIA live region announcing save status and export completion.
- WCAG AA contrast on UI chrome (catalog swatches exempt — they represent real paint colors).
- Breakpoints: full 3-pane ≥1280px; collapsed 768–1279px; read/compare-only <768px (intentional).

### 5.12 Acceptance criteria (v2 spec, "what done means")

- Create project → upload photo → clean → generate 3+ masked layers via ≥2 selection tools →
  assign catalog colors → **refresh → exact same state restored**.
- Changing a layer's color updates the canvas with no visible "apply" step and no full-canvas
  re-render lag on a 4K source.
- Undo/redo works across a session; history entries visible/scrubbable.
- Side-by-side and slider comparisons both exportable to PDF without blocking edits.
- Manager role views Reports and all reps' projects; Rep cannot access another rep's project by
  direct URL manipulation (server-enforced).
- Full workflow completable on a 1280px+ laptop and functionally usable on a 768px tablet.

### 5.13 Explicit migration note

If v1 has existing users/data mid-flight, wrap each legacy upload+applied-color result into a
single-project, single-layer record via a one-time migration script rather than leaving v1 data
orphaned. `reconcileUploads.js` already re-links orphaned on-disk folders (depth ≤2 walk, dry-run
by default, `ON DUPLICATE KEY UPDATE`).

---

## 6. API reference & flows

Base URL: `http://localhost:4000` (`VITE_API_BASE_URL`). All `/api/*` routes sit behind
`requireAccessKey` (`x-api-key` header; **passes if the key is unset or
`change-me-long-random-string`** — fails open). `GET /health` and `GET /files/*` are public.
Request limits: `express.json({limit:'2mb'})`; multer memory storage 10–25 MB depending on route.
Files served at `GET /files/<relative-path>` via `storage.service.absolutePath` (path-traversal guarded).

### 6.1 Endpoint reference

**Projects**

| Method & Path | Body / Params | Response | Notes |
|---|---|---|---|
| `GET /api/projects` | query: search, status, filters | `{ rows, total, page, pageSize }` | no server pagination today |
| `POST /api/projects` | `{ name, client_name, status? }` | project row | CreateProjectModal |
| `GET /api/projects/:id` | — | project row | |
| `PATCH /api/projects/:id` | partial patch **+ `updatedAt`** | project row | optimistic-conflict 409 header; no UI caller sends `updatedAt` today |

**Assets (per project)**

| Method & Path | Body | Response | Notes |
|---|---|---|---|
| `POST /api/projects/:projectId/assets` | multipart `image` | asset row | multer; saved `uploads/<assetId>/original.jpg` |
| `GET /api/projects/:projectId/assets` | — | asset rows | AssetsTab |
| `GET /api/assets/:assetId` | — | asset row | |
| `PATCH /api/assets/:assetId` | `{ label }` | asset row | rename |
| `DELETE /api/assets/:assetId` | — | 204 | cascades layers/jobs/analysis; deletes masks + empty dirs |
| `POST /api/assets/:assetId/duplicate` | — | new asset row | copies original file (not layers) |
| `POST /api/assets/:assetId/clean` | multipart `mask` (optional) | updated asset with `cleaned_path` | object removal via `aiProxy` (clipdrop/huggingface) |

**Layers**

| Method & Path | Body | Response | Notes |
|---|---|---|---|
| `POST /api/assets/:assetId/layers` | multipart `mask` + `{name, createdVia, currentColorId, opacity, orderIndex, aiSurfaceKey, aiAnalysisId, aiSchemeId}` | layer | `createdVia ∈ {brush, magic-wand, lasso, rect, polygon, ai-surface}`; ai-surface upsert → 201 new / 200 updated |
| `GET /api/assets/:assetId/layers` | — | layers (order_index ASC, deleted filtered) | |
| `PATCH /api/layers/:id` | JSON or multipart (when `mask` present) + `updatedAt` | layer | mask edit = new alpha PNG; `mask_path` re-points |
| `DELETE /api/layers/:id` | — | 204 | soft-delete — undo restores |
| `POST /api/layers/:id/restore` | — | layer | undo of delete |

**AI**

| Method & Path | Body | Response | Notes |
|---|---|---|---|
| `POST /api/assets/:assetId/ai/analyze` | — | analysis result + job meta | 404 no asset; **403** if `AI_ANALYSIS_ENABLED=false`; writes `ai_jobs` audit row |
| `GET /api/assets/:assetId/ai/analysis` | — | `{analyzed, job, house, context, surfaces, objects}` | latest succeeded job + decoded surfaces/objects |
| `POST /api/assets/:assetId/ai/recommendations` | `{ count? }` | recommendations | 409 if no analysis; 409 if catalog empty |
| `GET /api/assets/:assetId/ai/recommendations` | — | recommendations (scheme_json with full paint objects) | |
| `GET /api/meta` | — | `{ capabilities: {houseUnderstanding, paintRecommendation: enabled}, providers }` | drives AI toggles; staleTime 60s |

**Catalog**

| Method & Path | Body | Response |
|---|---|---|
| `GET /api/catalog` | query: page, pageSize, search, line, hex, favoritesOnly | `{ rows, total }` |
| `GET /api/catalog/:id` | — | paint |
| `POST /api/catalog` | paint (zod-validated) | paint (409 on duplicate color_code) |
| `PUT /api/catalog/:id` | paint | paint |
| `DELETE /api/catalog/:id` | — | 204 (soft delete) |
| `POST /api/catalog/import/preview` | multipart `file` (xlsx) | `{ totalRows, valid[{row,data,action,existingId}], errors[{row,raw,issues}], summary }` |
| `POST /api/catalog/import/commit` | `{ validRows, fileName, duplicateStrategy: 'update'|'skip'|'create_new' }` | `{ created, updated, skipped }`; `import_log` row; transaction |
| `GET /api/catalog/import/export` | — | xlsx buffer |

**Per-project supporting**

| Method & Path | Body | Response | Notes |
|---|---|---|---|
| `POST /api/projects/:projectId/history` | `{ description, payload }` | entry | append-only |
| `GET /api/projects/:projectId/history` | — | entries | unbounded server-side (H-10) |
| `POST /api/projects/:projectId/concepts` | multipart `thumbnail` + `{name, layerColorMap}` | concept | thumbnail + surfaceClass→paintId map |
| `GET /api/projects/:projectId/concepts` | — | concepts | gallery |
| `POST /api/projects/:projectId/exports` | multipart `file` + `{format, comparisonMode}` | export job | format png / side-by-side-jpg; **pdf → 501** |
| `GET /api/projects/:projectId/exports` | — | exports | |
| `GET /api/exports/:id` | — | export row | |

**Ops:** `GET /health` → `{ status: 'ok', ... }`. `GET /files/*` static-ish serving from storage root.

### 6.2 End-to-end flows

**Flow A — Upload → Understand → Scheme → Apply → Save concept**
```
AssetsTab upload ──POST /projects/:pid/assets──▶ assets row + original.jpg
AIAnalyzeTab "AI Understand" ──POST /assets/:aid/ai/analyze──▶
   houseUnderstanding.service → aiRegistry.run('house-understanding', {buffer})
   → ai_jobs(running) → provider (mock/http) → ai_jobs(succeeded|failed)
   → detected_surfaces + detected_objects + masks under uploads/<assetId>/ai/
RecommendationsTab ──POST /assets/:aid/ai/recommendations──▶
   catalogRecommendationProvider → paint_recommendations (prev batch cleared)
   [frontend renders previews via renderSchemePreview = baseImage + masks + applyPaintColor]
Apply scheme ──useApplySurface──▶ POST /assets/:aid/layers × surfaces
   (createdVia='ai-surface', aiAnalysisId, aiSurfaceKey, aiSchemeId, currentColorId, maskBlob)
   → layers.model.upsertAiLayer (201 new | 200 in-place update, never duplicates)
   → history 'create' → /projects/:pid/history
Save as concept ──POST /projects/:pid/concepts──▶ concepts row (thumbnail + layerColorMap)
Apply concept later ──useApplyConcept──▶ same Apply-scheme path → editable layers
```

**Flow B — Manual painting + undo/redo**
```
Brush stroke → maskOps.rasterizeBrushStroke → VisualizerWorkspace.handleCommitMask
  new layer?  → POST /assets/:aid/layers (createdVia='brush') + history 'create'
  mask-edit?  → serialized queue → mergeMasks(base, stroke, add|subtract)
              → PATCH /api/layers/:id (multipart mask) + history 'mask-edited'
  eraser?     → always 'subtract' against active layer
Undo (Ctrl+Z) → useHistoryCommand: local instant undo + history entries (patch/create/delete/bulk-delete)
  mask undo   → re-points mask_path server-side → in-memory mask cache cleared
```

**Flow C — Object removal**
```
Surface select → brush/lasso/rect mask → POST /assets/:aid/clean (multipart mask)
→ aiProxy.service (AI_PROVIDER||'clipdrop') → clipdrop|huggingface (30s timeout, 2 retries)
→ resulting image saved as cleaned_path → asset.cleaned_path
Visualizer header Compare: Original | Cleaned | Painted (uses cleaned_path when active)
```

**Flow D — Export**
```
ExportPanel: select mode (side-by-side|slider|split|fade) + format png
→ client re-composite (baseImageData + layers + colorLookup) → blob
→ POST /projects/:pid/exports (multipart) → export_jobs row → history of the export in panel
```

**Flow E — Catalog import**
```
ImportModal → POST /catalog/import/preview (xlsx) → validation/diff report (zod + findByColorCode)
→ user confirms → POST /catalog/import/commit {validRows, duplicateStrategy}
→ paints create/update inside a transaction + import_log row
```

### 6.3 Error taxonomy

| Status | Meaning | Where |
|--------|---------|-------|
| 400 | Validation failed (zod, or bad params) | catalog, import, controllers |
| 403 | AI capability disabled (`AI_ANALYSIS_ENABLED=false` etc.) | houseUnderstanding.service |
| 404 | Unknown asset / project / layer / paint | controllers + services |
| 409 | "Analyze the asset first…" (recommendations before analysis) · "The paint catalog is empty…" · ai-surface conflict · optimistic `updatedAt` mismatch | paintRecommendation.service, layers.controller, projects/layers models |
| 422 | Invalid scheme payload | layers/ai controllers |
| 500 | Provider failure (job marked `failed` with `failure_reason` sliced to 500 chars) | aiRegistry, providers |
| 501 | `format=pdf` (deferred) | exports.controller |

Frontend surfaces `body.error` as toast text and preserves `err.status` for the timeout/retry distinction.

---

## 7. AI features

Two AI capabilities ship with **provider-less defaults — zero API keys, zero network calls**:

- **House Understanding** uses the **`mock`** provider (pure heuristic image understanding via
  `jimp`, already a backend dependency). Set `AI_ANALYSIS_PROVIDER=http-vision` (plus
  `AI_VISION_URL`/`AI_VISION_API_KEY`) to plug in a real segmentation vendor; the response schema
  is identical, so providers are drop-in interchangeable.
- **Paint Recommendations** use the **`catalog`** provider (rule-based color theory scored against
  paints already in your catalog) — colors are always real products, never invented.

Both features follow the same platform rules: **the AI only produces structured understanding; the
existing LAB rendering engine and layer pipeline stay authoritative for applying paint. The AI
never invents colors and never paints a non-paintable surface.** Both are independently
feature-flagged (`AI_ANALYSIS_ENABLED`, `AI_RECOMMENDATION_ENABLED`, default true) and surfaced in
`GET /api/meta`.

### 7.1 House Understanding (Feature A)

- **Objective:** analyze a photo into structured understanding: house present? → style/material/
  color; paintable surfaces (walls, roof, trim, gutters, doors); protected objects (windows, trees,
  cars, neighbor houses). Everything produced is metadata + mask files; nothing is painted.
- **Pipeline (server-side, `POST /api/assets/:assetId/ai/analyze`):** provider-agnostic via
  `aiRegistry.service.js`; every run writes a versioned, append-only `ai_jobs` row (provider, model
  version, confidence, processing time, failure reason, output summary). Surfaces/objects persist in
  `detected_surfaces`/`detected_objects` (metadata + file ref); mask pixels are alpha PNGs on disk.
  `paintable` is the hard guard the brush/apply flows read.
- **Analysis resolution:** `AI_ANALYSIS_MAX_DIM` (default 640) downscale for a small request
  envelope; masks are scaled back up to full resolution when promoted to layers.
- **mock provider** (`mock-understanding-v1`): Jimp heuristics — sky/green classification, house
  bounding box, per-surface masks (roof, front/left/right walls, trim, gutters, windows, door),
  connected-component object detection (trees, obstacles, neighbor houses), context colors,
  style/material guesses, hand-assigned confidences. No API key, fully in-process.
- **http-vision provider:** POSTs the downscaled photo as PNG data-URI to `AI_VISION_URL`
  (with `AI_VISION_API_KEY`/`AI_VISION_MODEL`/`AI_VISION_TIMEOUT_MS`, 60s) and validates the
  response against the same output schema — providers are drop-in interchangeable.
- **Standard output contract** (`aiResult.js` envelope: `ok, confidence, processingTimeMs,
  modelVersion, provider, failureReason`):
  ```jsonc
  {
    "scale":  { "width": W, "height": H, "factor": 1 },
    "house":  { "present": bool, "bbox": {...}, "confidence": 0..1, "style": "ranch|modern|traditional|unknown", "material": "...", "color": {r,g,b} },
    "surfaces": [ { "key": "front-wall", "displayName": "...", "paintable": true, "confidence": 0..1,
                    "mask": { "width", "height", "alpha": Uint8Array 0..255 },
                    "geometry": {"bbox", "areaPx", "areaRatio"}, "averageColor": {r,g,b}, "properties": {...} } ],
    "objects":  [ { "key": "tree-1", "className": "tree", "paintable": false, "confidence": 0..1, "mask": {...}, "geometry": {...} } ],
    "context":  { "skyColor", "groundColor", "roofColor", "wallColor", "lighting": 0.7..1.3, "palette": [{r,g,b}] }
  }
  ```
  A provider only needs to return this shape; **no downstream code changes when the provider changes.**
- **UI:** side-panel **AI Understand** tab — "Understand this photo" CTA, provider/model/confidence/
  time meta, list of detected surfaces (paintable ones get "Add layer"; protected ones tagged
  "Not paintable"), protected-objects list. **Surface lock**: when the active layer came from AI
  analysis (`ai_surface_key` set), brush strokes are clipped to the detected surface mask
  (`aiSurfaceLock`, default on) so paint cannot escape the surface; Inspector shows an
  "AI surface · <key>" badge.
- **Performance:** one-off, synchronous, in-process for `mock` (hundreds of ms on 640px); no hot
  path affected. **Rollback:** feature flag disables server-side (403) + UI hidden from `/api/meta`.

### 7.2 Paint Recommendations (Feature B)

- **Objective:** generate 5–10 complete, dealer-presentable paint schemes. Each scheme is a named,
  tagged color plan mapping every role (primary wall, accent wall, trim, doors, roof, gutter) to a
  specific detected surface and a specific catalog paint.
- **Requires** a successful house-understanding first (409 if missing) — grounded in actual
  detected surfaces, never invented. Runs server-side
  (`POST /api/assets/:assetId/ai/recommendations`); provider bound by `AI_RECOMMENDATION_PROVIDER`
  (default `catalog`).
- **catalog provider** (`catalog-rules-v1`): rule-based color theory (complementary, analogous,
  neutral, monochrome) across 8 named templates (`classic-neutral`, `coastal`,
  `modern-monochrome`, `earthy-warm`, `bold-accent`, `soft-pastel`, `heritage`,
  `fresh-garden`), scored against catalog paints actually available. `ROLE_BY_CLASS` maps detected
  classes → roles (front-wall→primary-wall, left/right-wall→accent-wall, roof, trim, gutter,
  doors...); `ROLE_ORDER` fixes presentation; `keep:true` retains the roof. Each assignment is
  validated against the detected paintable surface set — a scheme physically cannot reference a
  non-paintable or non-detected surface.
- **Count/scope:** `AI_RECOMMENDATION_COUNT` (default 6, clamped 1–10);
  `AI_RECOMMENDATION_PRODUCT_LINES` optionally restricts the candidate pool (falls back to whole
  catalog when empty). Schemes persist in `paint_recommendations` (`scheme_json` holds
  role→surface→paint); regenerating replaces the asset's previous batch. The API resolves scheme
  paints to full paint objects on read (`resolveScheme`).
- **UI:** **AI Schemes** tab — "Generate N schemes" button; each card shows name, tagline, a swatch
  strip (one per role), role→paint mapping, and an **Apply** button that creates real, editable
  layers (via the same `useApplySurface` path as hand-drawn layers — `createdVia: 'ai-surface'`, so
  undo/redo/history treat them identically). "Catalog-only — every color is a real product" is shown
  on each card. **Save as concept** persists a rendered thumbnail + `layerColorMap`; applying a
  concept later re-creates editable layers, not a static picture.

### 7.3 AI pipeline — stage map (operator view)

| Stage | What happens | Key files |
|---|---|---|
| 1. Upload | photo → `assets` row + file on disk | `AssetsTab.jsx` → `api.js` → `assets.routes/controller` → `storage.service` |
| 2. Analysis ("AI Understand") | `POST /ai/analyze` → registry → provider → `ai_jobs`, `detected_surfaces`, `detected_objects`, mask PNGs | `ai.controller` → `houseUnderstanding.service` → `aiRegistry` → `mockProvider`/`httpVisionProvider` |
| 3. Recommendations ("AI Schemes") | `POST /ai/recommendations` → catalog-only rules → `paint_recommendations` (prev batch cleared) | `paintRecommendation.service` → `catalogRecommendationProvider` |
| 4. Preview & select | thumbnails composed client-side with the exact `applyPaintColor` args `LayerNode` uses → preview == final render | `renderSchemePreview.js`, `RecommendationsTab.jsx` |
| 5. Layer creation (idempotent) | `POST /api/layers` with `createdVia='ai-surface'`; server upsert on `(ai_analysis_id, ai_surface_key)` — re-apply updates in place, never duplicates | `useApplySurface.js` → `layers.controller` → `layers.model.upsertAiLayer` |
| 6. Render | layers → `LayerNode` → `applyPaintColor` composite → Konva; color change re-renders that layer only | `CanvasStage.jsx`, `LayerNode.jsx`, `colorEngine.js` |
| 7. Concepts | Save as concept → `concepts` table; gallery lists them; apply re-runs Stage 5 → editable layers | `RecommendationsTab.jsx`, `AssetsTab.jsx`, `useApplyConcept` |
| 8. Semantic editing | surface-pick tool hit-tests analysis masks; brush refine clipped to surface; clear-all-paint batch reset | `maskOps.pickSurfaceAtPoint`, `clipMaskToConstraint`, `surfaceAwareBrushStroke`, `visualizerStore.clearAllPaint` |

**Failure modes:** Analyze without asset → 404. AI disabled → 403. Recommendations before any
analysis → 409. Empty catalog → 409. Provider crash → job `status='failed'` + `failure_reason`,
surfaced in the tab. Invalid scheme → 422.

### 7.4 Environment (backend `.env`, see `.env.example`)

```
AI_ANALYSIS_PROVIDER=mock             # mock | http-vision | (future: sam-grounded | gemini)
AI_RECOMMENDATION_PROVIDER=catalog    # catalog | (future: vlm)
AI_ANALYSIS_MAX_DIM=640
AI_RECOMMENDATION_COUNT=6             # clamped 1–10
AI_ANALYSIS_ENABLED=true
AI_RECOMMENDATION_ENABLED=true
AI_VISION_URL / AI_VISION_API_KEY / AI_VISION_MODEL / AI_VISION_TIMEOUT_MS=60000
AI_PROVIDER=clipdrop                  # object removal: clipdrop | huggingface
HF_API_KEY / HF_MODEL / HF_API_URL    # when AI_PROVIDER=huggingface
CLIPDROP_API_KEY                      # when AI_PROVIDER=clipdrop
```

### 7.5 AI stack analysis — where the "AI" really stands (2026)

**What runs today:** the user-facing experience says "AI" for understanding, but understanding is
heuristic (`mockProvider.js`, ~560 LOC deterministic rules). Paint recommendations are
deterministic, explainable, catalog-only — **by design**, per spec ("the AI layer never invents
colors"). Object removal (`aiProxy` → clipdrop/huggingface) is **real**: external inpainting models,
key-gated. Only the model choice (and a working key) separates it from a real inpainting result.

| Dimension | mockProvider today | Foundation-model pipeline |
|-----------|--------------------|---------------------------|
| Segments learned? | No — hard-coded rules | Yes (zero-shot) |
| Handles unseen building styles | Poor (row-band assumptions) | Strong |
| Confidences meaningful? | No (fixed constants) | Yes (model-derived) |
| Objects (cars, people, pets) | Rough blob heuristics | Yes, open-vocabulary |
| Occlusion handling | None | Decent→good (SAM2/DINOv3) |
| Cost | Free (CPU) | Tokens/GPU minutes |
| Latency | ~1–4 s | ~1–15 s (varies) |

**Candidate paths (both are config-only swaps — the registry/contract/job-audit/upsert are done):**

- **Managed API (fastest credible upgrade):** `AI_ANALYSIS_PROVIDER=http` + a managed endpoint that
  speaks the standard contract. **Gemini 2.5 Flash segmentation mode** returns masks natively as
  base64 PNGs + boxes (~$0.001–0.003 per segment call) — a single call yields the entire
  surfaces/objects contract. Replicate/fal.ai hosted Grounding-DINO + SAM2 also fit
  `httpVisionProvider.js`/`huggingface.js` seams. Zero code change; one env + one key.
- **Self-hosted default (best quality):** **Grounded-SAM 2** — Grounding DINO 1.6 (text queries:
  `roof, front wall, trim, windows, door, gutters, tree, car, person...`) → SAM 2 (masks) → the
  existing `ROLE_BY_CLASS` map to emit the standard contract. A new `samGroundedProvider.js` file
  (or the included local vision-service, see §7.6). Apache-2.0 models.
- **Recommendation upgrade (optional):** keep the deterministic catalog scorer; generate
  `rationale`/`tagline` via a VLM (Qwen2.5-VL / Gemini) so scheme cards get human-readable reasoning
  while staying catalog-only (`paint_recommendations.rationale` is already a JSON column).
- **Versioning already exists:** every run stamps `provider` + `model_version` into `ai_jobs`, so
  A/B comparing providers is a query, not archaeology.

**Risk table**

| Change | Risk | Mitigation |
|--------|------|-----------|
| Env swap to managed VLM | Cost, data leaves premises (client photos) | Keep `mock` default in dev; explicit opt-in; rate limit AI routes |
| Self-hosted GPU | Ops burden, uptime | Use HF Inference Providers first; self-host only if volume justifies it |
| Provider A/B drift | Different masks per provider → layers reference `ai_analysis_id`, so mixed analyses are fine by construction | Job versioning + schema version column already present |

### 7.6 Local vision service (Grounded-SAM2) — `backend/vision-service`

A small local **Python** service that replaces the mock house-understanding heuristic with a real
open-vocabulary detector (Grounding DINO) + segmenter (SAM2), running locally on your GPU — no API
key, no per-call cost, photos never leave the machine. It speaks the exact JSON contract
`httpVisionProvider.js` already expects, so wiring it in is **a config change only**:

```
pip install --index-url https://download.pytorch.org/whl/cu130 torch   # CUDA-matched build
pip install -r requirements.txt
uvicorn server:app --host 127.0.0.1 --port 8008
```
```
# backend/.env
AI_ANALYSIS_PROVIDER=http
AI_VISION_URL=http://127.0.0.1:8008/analyze
AI_VISION_TIMEOUT_MS=60000
```

Grounding DINO is prompted with: roof, wall, window, door, tree, car, person, fence, sky, ground;
SAM2 turns each detected box into a pixel mask. Trim/gutter are derived geometrically (thin strips
a box detector handles poorly), and wall is split into front/left/right by position in the detected
house bbox. Tiny model variants (`grounding-dino-tiny`, `sam2-hiera-tiny`) used for speed on a
laptop GPU; swap `DINO_MODEL_ID`/`SAM_MODEL_ID` in `pipeline.py` for quality. No columns/railings/
balconies/garage doors (extend `PROMPT_CLASSES` + `SURFACE_META`/`OBJECT_META`); confidences are
real detector box scores, not calibrated probabilities.

---

## 8. Implementation status

| Area | Status |
|---|---|
| Catalog CRUD, Excel import/export | ✅ working (unchanged from v1) |
| Project-centric IA (Dashboard / Projects / `/projects/:id/visualize`) | ✅ working |
| Konva canvas: layers-with-masks, live per-layer recolor | ✅ working |
| Selection tools: rect, lasso, polygon, magic wand, brush (mask-edit + direct-paint), bucket fill, eyedropper (+ eraser, pan) | ✅ working |
| Undo/redo (command pattern) + scrubbable History tab | ✅ working |
| Autosave (optimistic + debounced) + IndexedDB draft cache + conflict toast | ✅ working (conflict toast unreachable until `updatedAt` is wired) |
| Paint Catalog cards, favorites/recently-used (localStorage), hex-proximity search, hover-preview | ✅ working |
| Layer-aware AI color suggestions (samples outside the active layer's actual mask) | ✅ working |
| Comparison modes (side-by-side/slider/split/fade) + PNG/side-by-side-JPG export | ✅ working |
| Keyboard shortcuts, ARIA live save/toast status, responsive breakpoints (full 3-pane ≥1280px, collapsed 768–1279px, read-only <768px) | ✅ working |
| AI cleanup proxy | ⚠️ wired, needs a real provider API key |
| **AI House Understanding** — structured scene analysis; paintable surfaces become one-click layers; surface-lock brush | ✅ working (mock provider; `http-vision` drop-in) |
| **AI Paint Recommendations** — 5–10 catalog-only schemes that apply as real, editable layers | ✅ working (rule-based `catalog` provider) |
| AI layer idempotency (unique key + server upsert, never duplicates) | ✅ working |
| Rendered scheme previews + Save-as-concept + concept gallery (apply → editable layers) | ✅ working |
| Semantic surface-pick tool + mask-refine modes + clear-all-paint | ✅ working |

**Explicitly deferred (not stubbed, not silently faked):** RBAC/roles · Reports · PDF export with
dealer branding (501, not a silent downgrade) · Spray tool · brush hardness slider · fullscreen
toggle · Konva `.cache()` layer caching · full-res export pipeline (exports capped at editor res).

### 8.1 Feature-completeness deltas that were *silently* missing (not documented as deferred)

From the 2026-08-03 enterprise audit: fullscreen toggle (spec §5.1), spray tool, brush hardness
slider, Konva layer `.cache()`, the sidebar "swatch rail" (the signature v1 element — `activeColor`
state is threaded through but `Sidebar` renders nothing), project status-change UI (statuses are
filterable/badged but nothing can change them), `reference_note` (schema + model, no UI), and
`useUpdateProject` (defined, zero call sites).

---

## 9. Audit findings & risk register

> Consolidated from four overlapping audits (2026-08-01 through 2026-08-05). Findings are
> deduplicated; severity reflects the strictest audit. Verified by reading the executing code,
> not README claims.

### 9.1 Executive verdict (across audits)

- **Working scaffold, not a finished product.** Core loops are real and verified: catalog CRUD,
  Excel import/export, client-side LAB recolor, command-pattern undo, autosave + IndexedDB draft,
  project lifecycle, AI understanding/recommendations (on mock/catalog providers), PNG/JPG export.
- **Not shippable as-is** due to one real correctness bug (Excel import transaction), two security
  exposures (live HF key on disk, unauthenticated `/files/*`), one config gap (compose has no
  access key / AI env), plus no tests/CI/lint.
- **Production readiness score: ~3.4/10** (Architecture 7, Correctness 5, Security 4, Performance 6,
  Scalability 3, UX/a11y 7, Product completeness 6, Production readiness 3, Code quality 7, Testing 1).
- **Product maturity: ALPHA** — a pilot-buildable rendering engine, 6–12 months of focused product
  work from a defensible MVP. Completeness index across product features ≈27% (rendering engine itself ≈75%).

### 9.2 Correctness & data-integrity findings

| ID | Severity | Finding | Where |
|----|----------|---------|-------|
| P0 | Excel import transaction doesn't wrap the writes | `beginTransaction/commit/rollback` are inert — `paintsModel.create/update` use the shared **pool** (autocommit); only the `import_log` row uses the `conn`. A failure mid-loop leaves the catalog half-written. | `backend/src/services/excelImport.service.js:55-98` |
| P1 | Re-importing a soft-deleted color crashes the import | `findByColorCode` excludes `is_deleted=1`, so a soft-deleted row classifies as `create` → `ER_DUP_ENTRY` on `uq_color_code`. | `paints.model.js:72-78` |
| P2 | Optimistic-concurrency checks are inert | `updatedAt` 409 checks exist (projects/layers models) but no UI caller passes `updatedAt` — the conflict toast is unreachable. | `projects.model.js:57-71`, `layers.model.js:53-74` |
| P2 | Unbounded mask-file accumulation | Every mask edit uploads `layer_<ts>.png`; previous files deliberately kept for undo, but never swept. Only asset deletion removes them. | `layers.controller.js:66-67` |
| P2 | `deleteAsset` misses export/concept files; no project delete | Project-scoped files under `uploads/projects/...` accumulate with no lifecycle owner. | `assets.controller.js:90-119` |
| P2 | No pagination on `listProjects`; unclamped `pageSize` | Full-table returns; `Number(pageSize)` passed straight into `LIMIT ?` with no clamp/NaN guard. | `projects.model.js:27-45`, `paints.controller.js` |
| P2 | Stored type/extension mismatch | Everything saved as `.jpg` regardless of actual upload content; no multer `fileFilter`. | `assets.routes.js:7`, `assets.controller.js:21,66` |
| P3 | Excel `id`/`s_id` ambiguity | `mapRow()` skips the `id` column with "confirm this is correct" TODO. | `paints.validation.js:23-27`, `excelImport.service.js:126` |
| P3 | Orphaned upload folders | `backend/uploads/uploads/` legacy layout has rows in no current DB. | — |

### 9.3 Security findings

| ID | Severity | Finding | Where |
|----|----------|---------|-------|
| P0 | **Live Hugging Face API key on disk** | `backend/.env` holds `HF_API_KEY=hf_…` + a `{burned}` comment (a prior key already leaked). Gitignored (not in git history), but at rest in the working copy; bills to the owner's HF account with no spend limit. **Rotate now.** | `backend/.env:30` |
| P0 | **`/files/*` serves everything without auth** | Mounted outside `/api` and the `requireAccessKey` guard — every photo, mask, concept thumbnail, and export is publicly readable by URL. Fine for LAN; a blocker if public. | `backend/src/app.js:50-56` |
| P1 | Access key fails open | Requests pass when `API_ACCESS_KEY` is unset or equals the placeholder. Compose never sets it → composed backend is wide open. | `middleware/accessKey.middleware.js` |
| P1 | SSRF-ish model-URL fetch | `fetchRemoteImage` downloads a model-returned URL with the `Authorization: Bearer <HF key>` attached, no timeout/size-cap (bypasses `httpClient`). A hijacked endpoint could hit internal services carrying the key. | `huggingface.js:95-104` |
| P1 | Catalog Export link broken under real key | Plain `<a href>` cannot attach `x-api-key` → 401 once a real key is configured. Fix: fetch-as-blob or signed token. | `CatalogPage.jsx:97`, `api.js:49` |
| P2 | Hardcoded DB credentials in compose | `root_change_me` / `change-me`; MySQL port published to host. | `docker-compose.yml:8-11` |
| P2 | Weak path-traversal guard | `full.startsWith(UPLOAD_ROOT)` can be bypassed by a sibling-prefix trick (`/files/..%2F..%2Fuploads-evil/x.png`). Use `path.relative` + containment. | `storage.service.js:19-26` |
| P2 | No rate limit on `/clean` | A loop can burn the billed hosted-model credit balance. | `app.js` |
| P2 | Error messages leak internals | Raw `err.message` returned to clients (multer/DB/provider details). | `errorHandler.middleware.js` |

**Debunked claims (verified against source):** no committed API keys (`.env` files gitignored,
untracked); no Three.js/WebGL anywhere (Konva on 2D canvas); bundle is fine at 0.90 MB; layer
routes are not double-mounted; PDF export is explicitly deferred (501), not broken.

### 9.4 PLACEHOLDER_REPORT — mock, stand-in, and deferred inventory (legend: Placeholder / By design / Deferred / Healthy)

| Capability | Status | Effort to make "real" |
|------------|--------|-----------------------|
| House understanding | **Placeholder (mock heuristic)** — self-labeled "Developer Mock"; deterministic, works on simple centered-front photos, degrades on angled/occluded/multi-storey. Fixed confidences are **not** model confidence and should not be shown as such. | Low via env swap; Medium for self-hosted Grounded-SAM |
| Paint recommendations | By-design rules (real, catalog-only) | Low optional VLM-rationale polish |
| Object removal | Real (key-gated external: clipdrop/huggingface) | Low (choose model) |
| PNG / side-by-side export | Real | — |
| PDF export | **Deferred (501)** | Medium (server render pipeline) |
| Auth / multi-user | Absent by design (single shared `x-api-key`; favorites/collections are per-browser localStorage) | Large |
| Live color render | Real (single renderer) | — |
| Undo/redo | Real (command pattern + persisted) | — |

Other placeholders: `<768px` visualizer and `<1280px` panels are **by design**; `paints` has no
`finish`/`brand` columns (UI maps brand to product-line flags — documented in `PaintCard.jsx`);
`AIAnalyzeTab` empty state is healthy; Excel `id` handling is an **open TODO**;
`backend/package.json` description ("No image/AI processing happens here") is **stale** (Jimp AI exists).

### 9.5 What is genuinely good (keep)

- **One renderer.** `colorEngine.applyPaintColor` + `LayerNode` is the sole paint path; previews,
  exports, and the live canvas agree by construction.
- **Idempotent AI layers.** Unique key `(ai_analysis_id, ai_surface_key)` + server-side upsert
  (201 new / 200 update) — re-applying a scheme or concept never duplicates layers.
- **Command-pattern history** with optimistic updates and rollback, plus a persisted mirror.
- **Explainable AI artifacts.** `ai_jobs` is a versioned audit log; `paint_recommendations` stores
  role→surface→paint with rationale; recommendations are catalog-only by design.
- **Self-healing uploads** via `reconcileUploads.js` (reuses on-disk UUID as asset id).
- **Accessible, keyboard-first UI** (tool shortcuts with input/meta guards, ARIA live save status,
  focus management in modals, `prefers-reduced-motion`).
- **Clean layering:** controllers → services → models; storage behind one module; AI behind a
  capability registry with a standardized result envelope.
- **Correct state ownership:** TanStack Query (server), Zustand (ephemeral), IndexedDB (draft),
  localStorage (favorites/collections).
- **Unit-testable pure code:** `maskOps.js` (alpha channel = selection strength 0–255 contract),
  `colorEngine.js`, `colorSuggest.js`.

---

## 10. Performance report

All findings verified by reading the executing code path; sizes/latencies from the working-tree
inventory and code arithmetic, not load testing.

### 10.1 Measured baseline (static evidence)

| Metric | Value |
|--------|-------|
| Frontend production bundle (`frontend/dist`) | **0.90 MB total** (JS 0.87 MB) — no bundle problem |
| `backend/uploads` | 797 files / 36.1 MB; of which nested `backend/uploads/uploads` = 785 files / 30.7 MB (legacy/layer-mask layout) |
| Mask files (alpha PNGs) | 789 PNGs ≈ 28.9 MB |
| Catalog rows fetched by visualizer | `pageSize: 2000` (one cached query, staleTime 60s) |
| AI analysis input cap | `AI_ANALYSIS_MAX_DIM=640` → ≤640×~480px ≈ 300K pixels, Jimp on the Node main thread |
| Client render cap | `useImageElement.js` `MAX_DIMENSION=1600`; canvas ops on the browser main thread |

### 10.2 Frontend hotspots

- **H-01 · Per-layer full-res recompute with a fresh canvas (`LayerNode.jsx`)** — O(W×H) memory
  churn per layer-change (N × ~10 MB backing store at 1600px). Fix: reuse one scratch canvas per
  layer; only recompute when color/mask actually changes; LUT for selected paint.
- **H-02 · LAB pipeline on the main thread (`colorEngine.js`)** — ~1M+ pixel iterations per layer
  per change, in JS, janking the UI thread. Fix (highest impact): Web Worker / `OffscreenCanvas`,
  or a 32³ trilinear-interpolated 3D LUT (~32 KB) turning the inner loop into ~4 table reads + lerp.
- **H-03 · Repeated full-resolution mask loads** — every analysis change re-downloads/re-decodes
  every paintable mask at full canvas res; scheme previews independently re-derive per-surface masks
  per thumbnail. Fix: shared alpha-grid cache keyed by `mask_path + resolution`; previews at thumb size.
- **H-04 · Full-res `getImageData` on the main thread (`VisualizerWorkspace.jsx:80`)** — one-time
  per asset, duplicated per switch, also consumed by the eyedropper scan.
- **H-05 · Eyedropper O(catalog) nearest-LAB scan** — up to 2000 paints per click. Fix: precompute
  LAB once per catalog load; or 24³ quantized bucket probe.
- **H-06 · No HTTP timeout/abort (`shared/lib/api.js`)** — a hung `/ai/analyze` or `/clean` leaves
  a permanent spinner (Query won't cancel it). Fix: default timeout (60s AI / 15s elsewhere) with
  `AbortController`, surface `err.status === 0` as timeout.
- **H-07 · Serialized mask writes (`VisualizerWorkspace.jsx:155`)** — burst brush strokes queue one
  PNG encode + upload each. Fix: keep ordering, coalesce enqueued strokes (drain latest during a stroke).

### 10.3 Backend hotspots

- **H-08 · Synchronous filesystem everywhere (`storage.service.js`)** — `readFileSync/writeFileSync/
  mkdirSync/unlinkSync` on every file op block the single Node event loop (36 MB tree, AI mask saves,
  uploads). Fix: `fs/promises` — a ~40-line diff confined to the storage abstraction.
- **H-09 · AI provider runs synchronously in the request path** — mock ~1–4s, real provider 10–60s
  HTTP, and the client POST blocks. Fix: async analysis job (status `running` exists) + client polling.
- **H-10 · History unbounded** — `GET /api/projects/:id/history` returns all rows; frontend paginates
  40 with order-sensitive jump indices. Fix: server-side LIMIT/OFFSET + MAX guard.
- **H-11 · No analysis caching** — re-running "AI Understand" regenerates everything. Fix: cache by
  hash of `(asset, provider, model_version, original mtime)`.
- **H-12 · Preview/export re-derivation cost** — export re-composites at export size without the RAF
  coalescing; acceptable one-time, but the most expensive client op.

### 10.4 What is already fast (do not "fix")

- Bundle (0.90 MB — no code-splitting needed).
- Catalog list (one shared cached query, reused by CatalogPage + panels).
- LayerNode RAF coalescing + per-layer canvases (recompute is event-driven, not per-frame).
- Mask pipeline correctness (serialized write queue + mask cache eliminated real race bugs).
- Server-side HTTP client (30s timeout + retry/backoff).

---

## 11. Placeholder & deferred inventory

### 11.1 Backend

- `mockProvider.js` — placeholder "Developer Mock" for house understanding (see §7.5).
- `httpVisionProvider.js` — healthy BYO-model seam (config-only upgrade path).
- `catalogRecommendationProvider.js` — by-design explainable rules, not a mock.
- Object removal (`clipdrop.js`/`huggingface.js`) — real, key-gated.
- PDF export — deferred (501, by design).
- Auth/accounts — absent by design (single shared key; no per-user ownership).
- `docker-compose.yml` placeholder secrets (`root_change_me`/`change-me`) and DB-name mismatch
  (`paint_visualizer` vs `paint_visualizer_pro`).
- Storage = local disk (by design for MVP; single seam for S3/MinIO later).

### 11.2 Frontend / spec

- Spray tool, brush hardness slider, fullscreen toggle, Konva `.cache()`, sidebar swatch rail —
  spec items silently missing (see §8.1).
- `activeColor`/`onColorFocus` dead chain in `App.jsx`/`CatalogPage.jsx`/`VisualizerWorkspace.jsx`
  (`Sidebar` takes no props and renders no rail).
- Dead store fields `compareMode` + `inProgressMaskCanvas` (`visualizerStore.js`).
- `useUpdateProject` defined with zero call sites (hence no status-change UI).
- `exif_orientation` column never written or read — phone portrait shots can render/export sideways.
- `finish_override` is metadata-only — no render path (matte vs gloss does not differ visually).

### 11.3 Infra

- Frontend container runs `vite dev`, not a production build.
- Compose stack ships with a dead AI proxy (no `HF_*`/`CLIPDROP_*` env) and a fail-open access key.
- No tests, no lint/typecheck, no CI, no migration versioning, no observability, no backup strategy.
- `image.png` (~1 MB, untracked screenshot) at repo root — remove or document.

---

## 12. Improvement roadmap

### 12.1 SYSTEM_IMPROVEMENT_PLAN — consolidated remediation (Phase A–F)

**Phase A — Correctness & operational hardening (P0):**
- **A-1** Normalize storage layout (drop the redundant `uploads/` nesting; one-shot re-root migration; `reconcileUploads.js` read-only for legacy). M
- **A-2** Secrets hygiene + compose alignment (rotate HF key; pre-push `.env` guard; align DB names; read creds from `.env`). S
- **A-3** Frontend HTTP timeout/abort (`AbortController`, 15s/60s). S
- **A-4** Resolve the Excel `id`/`s_id` TODO + test. S
- **A-5** Server-side history pagination + max guard. S
- **A-6** Async storage I/O (`fs/promises`). S

**Phase B — Performance & UX (P1):**
- **B-1** OffscreenCanvas/Worker for paint composition. M
- **B-2** Shared mask/alpha-grid cache (thumb-size previews). S
- **B-3** Coalesce the mask-write queue (keep serialization). S
- **B-4** Async AI analysis job + polling. M
- **B-5** Catalog LAB precompute + eyedropper index. S
- **B-6** Analysis caching. M

**Phase C — Real AI understanding (P1/P2):**
- **C-1** Managed-model quick win — `AI_ANALYSIS_PROVIDER=http` at Gemini 2.5 Flash segmentation or Replicate/fal Grounded-SAM; **no code change**; add a visible "heuristic preview" badge when mock is active. S
- **C-2** Self-hosted Grounded-SAM 2 provider (`samGroundedProvider.js`). M/L
- **C-3** Real confidence semantics (relabel mock's fixed confidences in UI once real provider is default). S
- **C-4** VLM rationale/tagline for schemes (catalog-only preserved). M

**Phase D — Export & delivery (P2):**
- **D-1** Server-side PDF pipeline (Puppeteer/Chromium or canvas-node; dealer branding). M
- **D-2** S3/MinIO storage backend. M

**Phase E — Product trust & observability (P1):**
- **E-1** AI honesty surface (provider + model version + "rule-based preview" badge). S
- **E-2** Structured logging with request-id + AI job correlation. S
- **E-3** Health/readiness depth (DB pool + storage writability). S

**Phase F — Multi-user / auth (P2, product decision):**
- **F-1** Accounts + per-user data (sessions/JWT, `user_id` on projects, migrate favorites/collections out of localStorage). Large — do not attempt without a confirmed requirement.

**Cross-cutting principles:** every AI swap stays a config change (registry + envelope); keep the
single-renderer invariant; never remove the AI-layer idempotency guarantee; storage writes go
through `storage.service.js` only.

### 12.2 IMPLEMENTATION_PRIORITY — ordered backlog (Score = Impact × Effort-inverse)

**Quick wins — this sprint (no dependencies):**

| # | Item | Impact | Effort | Score |
|---|------|--------|--------|-------|
| 1 | Frontend fetch timeout/abort | 4 | S | 16 |
| 2 | Async storage I/O (`fs/promises`) | 4 | S | 16 |
| 3 | Rotate at-rest HF key + pre-push `.env` guard + compose/.env DB-name alignment | 4 | S | 16 |
| 4 | Server-side history pagination + max guard | 3 | S | 15 |
| 5 | Resolve Excel `id`/`s_id` TODO + test | 3 | S | 15 |
| 6 | AI honesty badge (provider + model_version + "rule-based preview" when mock) | 4 | S | 20 |
| 7 | Shared mask/alpha-grid cache | 3 | S | 15 |
| 8 | Coalesce mask-write queue | 3 | S | 15 |
| 9 | Catalog LAB precompute + eyedropper bucket probe | 2 | S | 10 |

**Expected result of this batch:** no more hanging spinners, no event-loop stalls, no
layout/secret confusion, honest AI labels, dedup'd image decode. Roughly one sprint.

**Next release — medium:** 10) storage layout normalization (before 13) · 11) managed-model AI
switch (highest user-visible gain, near-zero code cost — do as early as possible) · 12) async AI
analysis job + polling · 13) OffscreenCanvas/Worker paint composition · 14) analysis caching ·
15) request-id + AI job correlation logging.

**Strategic — roadmap:** 16) self-hosted Grounded-SAM 2 provider · 17) VLM rationale/tagline ·
18) server-side PDF export · 19) S3/MinIO storage · 20) multi-user auth (needs confirmed requirement).

**Dependency map:** quick wins → 10 storage → 19 S3 (needs 10) · 11 managed AI → 6 honesty badge →
12 async job → 14 caching / 16 Grounded-SAM · 13 worker paint → 17 rationale · 15 logging → 18 PDF.

### 12.3 90-day CTO roadmap (from enterprise audit)

- **Phase 0 — Hardening (Week 1):** rotate HF key; fix import transaction; protect `/files/*`;
  real access key in compose + stop fail-open; harden `fetchRemoteImage`; fix catalog export link;
  handle soft-deleted rows on Excel re-import.
- **Phase 1 — Product quality (Weeks 2–4):** full-resolution export pipeline; async export worker
  + progress; wire `updatedAt` conflict checks; mask-file retention sweep; project delete/archive
  + cleanup; restore swatch rail + fullscreen + spray/hardness.
- **Phase 2 — Operational readiness (Weeks 5–7):** tests (unit + integration + e2e); lint + typecheck
  + CI; production frontend container; compose/prod env + rate limit on `/clean`; migration
  versioning + backup/restore runbook + request-ID/error tracking.
- **Phase 3 — Scale & product (Weeks 8–12):** pagination/clamped `pageSize`; RBAC (Rep/Manager/
  Admin); Reports MVP; branded PDF; AI surface segmentation behind the provider seam.

### 12.4 Long-term product roadmap (architecture gap analysis, 0–36 mo)

- **P1 (0–3 mo):** hardening + pilot (tests, CI, secrets, `/files` guard, prod Docker, TS adoption begins).
- **P2 (3–6 mo):** trust & segmentation — async job/queue (BullMQ) + SSE; object storage abstraction;
  model registry; **SAM2 auto-masking** + manual refine; IQA upload gate; EXIF/orientation fix.
- **P3 (6–12 mo):** simulation & sales loop — finish/sheen shader (WebGL); coverage/quantity engine
  (litres from masked area); branded PDF proposal; shareable review links; client portal + e-approval; POS/ERP integration.
- **P4 (12–18 mo):** scale & multi-tenancy — tenancy + RBAC; multi-region; event-driven audit;
  usage analytics; open API; batch cleanup pipeline; offline/edge segmentation (ONNX/WASM).
- **P5 (18–36 mo):** category leader — interior 3D (WebGL room visualizer); AR capture; marketplace
  of providers/brands; personalized color ML; photoreal relight; white-label platform.

**Strategic position (from gap analysis):** the majors (Asian Paints, Dulux, SW, PPG) are
brand-locked, interior-centric SaaS tied to their own paint lines. Nobody owns "the neutral,
dealer-centric, multi-brand, exterior-first paint platform" — and this codebase's product-line
flags + provider-agnostic AI seam + dealer job model are the architectural seeds of exactly that
position. **The rendering core (photoreal repaint) is the hardest part and it exists; the next
12 months are about turning a rendering engine into a dealer's business tool** — identity,
workflow, simulation, and a dependable AI pipeline.

### 12.5 Definition of done (from AI pipeline implementation plan)

- Re-applying a scheme/analysis creates **zero** duplicate rows; re-apply updates color in place.
- Recommendations show rendered thumbnails; Save-as-concept persists and re-applies as editable layers.
- Clicking a detected surface selects it and paints the whole surface; brush refinement never escapes the surface.
- All existing features (upload, layers, history, export, catalog, color engine) continue to work.
- No change to the standard AI contract (`aiResult.js` envelope) or the renderer invariant
  (`colorEngine.applyPaintColor` is the only paint path).

---

## 13. Appendix — source documents

This file consolidates the following documents (now superseded). Reference them for
audit-trail detail and `file:line` evidence:

| Original file | Role |
|---|---|
| `README.md` | Project overview, architecture, run instructions, status |
| `v2.md` | Product & engineering specification (15 sections) |
| `AUDIT.md` | 2026-08-01 v1-era file-by-file audit (historical context — describes the retired v1 wizard architecture) |
| `API_FLOW.md` | Complete endpoint reference, end-to-end flows, error taxonomy |
| `AI_UNDERSTANDING_SPEC.md` | Feature A (house understanding) + Feature B (paint recommendations) specifications |
| `AI_PIPELINE.md` | Stage-by-stage pipeline map with file references |
| `ARCHITECTURE_DIAGRAM.md` | Mermaid diagrams + data model + scheme-apply flow |
| `IMPLEMENTATION_PLAN.md` | Phase 1–4 plan for the AI pipeline completion (dedup, previews, concepts, semantic painting) |
| `ROOT_CAUSE_ANALYSIS.md` | Verified execution flow + gap table for the AI understanding pipeline |
| `IMPLEMENTATION_PRIORITY.md` | Ordered backlog with impact/effort scoring |
| `SYSTEM_IMPROVEMENT_PLAN.md` | Consolidated remediation across all audit reports (Phases A–F) |
| `PROJECT_AUDIT.md` | 2026-08-05 full-stack audit (findings F-01…F-09, debunked claims) |
| `PROJECT_TECHNICAL_AUDIT_REPORT.md` | 2026-08-03 enterprise audit (P0s, scorecard, 90-day roadmap, evidence index) |
| `Paint_Visualizer_Full_Codebase_Audit_Report.md` | 2026-08-04 full codebase audit (file inventory, §16 prioritized recommendations) |
| `Paint_Visualizer_Architecture_Gap_Analysis.md` | 2026-08-04 level-2 architecture/product gap analysis (18 sections, competitor analysis, 5-phase roadmap) |
| `PERFORMANCE_REPORT.md` | Bottlenecks (H-01…H-12), measured baseline, ranked fixes |
| `PLACEHOLDER_REPORT.md` | Placeholder/by-design/deferred/healthy inventory + scorecard |
| `backend/vision-service/README.md` | Local Grounded-SAM2 vision service setup & wiring |
