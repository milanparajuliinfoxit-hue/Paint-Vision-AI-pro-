# Paint Visualizer — Full Codebase Audit Report

**Audit date:** 2026-08-04
**Scope:** Complete `paint-visualizer` monorepo (backend Express + MySQL, frontend React/Vite/Konva)
**Method:** Source-only static reverse-engineering audit; every claim below is traced to a `file:line` citation. No runtime/DB execution performed.
**Verdict (summary):** A well-crafted, internally coherent **pre-release scaffold** — impressive engineering for the client-side image pipeline, but **not shippable as-is**: real API key on disk, no tests/CI/lint, unauthenticated static file serving, and several documented-but-not-wired paths (AI surface selection, PDF export). See §17 for the prioritized fix list.

---

## Table of contents

1. [Scope & methodology](#1-scope--methodology)
2. [Repository & environment snapshot](#2-repository--environment-snapshot)
3. [Architecture overview](#3-architecture-overview)
4. [Data model / database schema](#4-data-model--database-schema)
5. [AI cleanup pipeline](#5-ai-cleanup-pipeline)
6. [Client image pipeline](#6-client-image-pipeline)
7. [API inventory](#7-api-inventory)
8. [Frontend architecture & state management](#8-frontend-architecture--state-management)
9. [Feature-completeness matrix (README claims vs code)](#9-feature-completeness-matrix-readme-claims-vs-code)
10. [Requirements coverage scoring (vs `v2.md`)](#10-requirements-coverage-scoring-vs-v2md)
11. [Security review](#11-security-review)
12. [Performance review](#12-performance-review)
13. [Production readiness](#13-production-readiness)
14. [Bugs, discrepancies & placeholders](#14-bugs-discrepancies--placeholders)
15. [File inventory (with citations)](#15-file-inventory-with-citations)
16. [Prioritized recommendations](#16-prioritized-recommendations)

---

## 1. Scope & methodology

- **Repo root:** `C:\Users\Lenovo\Downloads\paint-visualizer (1)\paint-visualizer`, branch `main`.
- Every backend source file, every frontend source file, root docs, env files, Dockerfiles, and the SQL schema were read in full. Several files read in earlier passes had truncated output; all were re-read completely.
- **Cross-referenced documents:**
  - `README.md` (v2 product README) — claims vs code checked in §9.
  - `v2.md` (product/engineering spec, untracked) — scoring in §10.
  - `PROJECT_TECHNICAL_AUDIT_REPORT.md` (untracked, prior audit) — prior verdict "*well-crafted pre-release scaffold, not shippable*"; this report independently confirms and extends that verdict.
  - `AUDIT.md` — v1-era historical audit; superseded by v2, not re-verified.
- **Not executed:** no DB, no runtime smoke test, no `npm install`/build (no tests exist to run — §13). This is a static audit.

---

## 2. Repository & environment snapshot

### 2.1 Git state

```
a5db303  Merge pull request #1 from .../uiEnchancement        (HEAD)
3b27aca  full implementaion of ai object removal and editing
1d4bae0  chore: initial commit - paint dealer visualizer MVP
```

**Uncommitted worktree changes (13 files, +666/−181):**
- `frontend/src/features/visualizer/**` — `VisualizerWorkspace.jsx`, `CanvasStage.jsx`, `LayerNode.jsx`, `ExportPanel.jsx`, `Inspector.jsx`, `store/visualizerStore.js`, `tools/maskOps.js`, `tools/toolDefs.js`, `tools/useToolInteraction.js`
- `frontend/src/shared/lib/colorEngine.js` — sRGB→linear **LUT**, fast `labL()` luminance, and a new `lightnessBlend` option that re-anchors masked-region lightness onto the paint's own lightness ("real coat" look)
- `frontend/vite.config.js` — adds `@tailwindcss/vite` plugin
- `README.md` — rewritten to v2 README (committed version was v1-era)
- `.claude/settings.json`

**Untracked files:** `PROJECT_TECHNICAL_AUDIT_REPORT.md`, `v2.md`, `image.png` (a screenshot; role unverified).

> ⚠️ The most impressive features (surface-aware brush, lightness-preserving recolor, Tailwind plugin) **exist only in the working tree, not in any commit**. The README already advertises them (`README.md:46–52`). A fresh clone of `main` would not match the README.

### 2.2 Toolchain

| Component | Version / detail | Evidence |
|---|---|---|
| Backend | Node, Express `^4.19.2`, CommonJS | `backend/package.json` |
| Frontend | React `^18.3.1`, Vite `^5.3.1`, Konva `^10.3.0`, react-konva `^18.2.16` | `frontend/package.json` |
| State | Zustand `^5`, TanStack Query `^5.101`, idb-keyval `^6.3` | `frontend/package.json` |
| DB | MySQL 8.0 (compose), `mysql2` `^3.10` | `docker-compose.yml:5`, `backend/package.json` |
| Validation | Zod `^3.23.8` (catalog CRUD only) | `backend/package.json:23`; `paints.controller.js:27,45` |
| Excel | `xlsx` `^0.18.5` | `backend/package.json:22` |
| UI libs | Radix (dialog/slider/tabs/toast/tooltip), lucide-react, framer-motion, Tailwind 4, CVA | `frontend/package.json:12–31` |

**No lockfiles committed** (only `package*.json` in Dockerfiles) and **no test/lint/build-check scripts** in either `package.json`.

---

## 3. Architecture overview

```
                ┌────────────────────────────┐   HTTP (JSON/multipart)
                │  FRONTEND  (browser)       │◄────────────────────┐
                │  React 18 + Vite + Konva   │                     │
                │                            │                     │
  upload ──►    │  useImageElement (≤1600px) │   /api/*             │
  photo         │  mask rasterization (JS)   │───────►  ┌──────────┴──────────┐
                │  LAB recolor on <canvas>   │          │  BACKEND (Express)  │
                │  suggestions (rule-based)  │          │  MySQL2 pool         │
  export ──►    │  composite → PNG/JPG blob  │          │  local disk /uploads │
                │  IndexedDB draft / undo    │          │  x-api-key middleware│
                │                            │          └──────────┬──────────┘
                └────────────────────────────┘                     │ POST /api/assets/:id/clean
                                              hosted AI (fal-ai   ▼
                                              FLUX.2 edit via HF)  router.huggingface.co
```

- **Client does all image work.** Applying a catalog color runs entirely in the browser on `<canvas>` using a LAB-space blend that preserves shading/texture (`frontend/src/shared/lib/colorEngine.js`). Each `Layer` composites independently in Konva so changing one layer re-renders only that layer (`LayerNode.jsx:8–16`).
- **Server = storage + thin AI proxy + CRUD.** No image processing in the backend process; the only AI call is `POST /api/assets/:id/clean`, forwarded to a hosted provider (`README.md:26–29`; `assets.controller.js:49–76`).
- **No auth/RBAC.** Single shared `x-api-key` guard (`app.js:37`; `accessKey.middleware.js`), explicitly a product decision (`README.md:30–31`, `v2.md` §10).
- **The `/files/*` route serves stored photos/masks/exports through a controlled endpoint rather than exposing the uploads folder directly** (`app.js:48–56`) — but it is **outside** `/api`, so it has **no key requirement** (see §11).

---

## 4. Data model / database schema

Schema: `backend/src/sql/schema.sql` (156 lines). Applied by `npm run migrate` → `scripts/runSchema.js` (additive + idempotent ALTERs, `runSchema.js:25–49`).

### 4.1 Entity map (all `ENGINE=InnoDB`, `utf8mb4`)

| Table | Lines | Notes |
|---|---|---|
| `paints` | `schema.sql:10–36` | catalog; `hex_value` is a **generated stored column** (`:25–30`); `UNIQUE uq_color_code` (`:34`); 7 product-line flags `tenprotect…surprised` (`:15–21`); soft-delete flag `is_deleted` (`:31`) |
| `import_log` | `schema.sql:38–47` | append-only Excel import audit (`rows_new/updated/skipped/error`, `error_detail JSON`) |
| `projects` | `schema.sql:65–78` | `status` enum draft/in_review/client_approved/archived (`:70`); `cover_asset_id` (`:71`); `tags JSON` (`:72`); **`updated_at TIMESTAMP(3)`** ms precision for optimistic concurrency (`:77`) |
| `assets` | `schema.sql:82–96` | UUID PK matching on-disk folder (`:83`); `original_path`/`cleaned_path` (`:86–87`); `status` enum uploaded/cleaning/cleaned/failed (`:91`); FK→projects `ON DELETE SET NULL` (`:95`) |
| `layers` | `schema.sql:101–118` | mask stored as **compressed alpha PNG on disk, never inline pixels** (`:99–100`); `created_via` enum brush/magic-wand/lasso/rect/polygon/**ai-surface** (`:106`); `deleted_at` soft-delete so undo restores same id+mask file (`:113`); FKs cascade to assets, SET NULL to paints (`:116–117`) |
| `history_entries` | `schema.sql:122–130` | append-only undo/redo log, `before/after_state JSON`, FK CASCADE (`:129`) |
| `concepts` | `schema.sql:134–142` | saved "looks"; `layer_color_map JSON` (`:139`) |
| `export_jobs` | `schema.sql:146–156` | `format` enum pdf/png/side-by-side-jpg (`:149`); `comparison_mode` enum side-by-side/slider/split/fade (`:150`); `updated_at(3)` |

The schema also **drops v1 tables** `job_results` and `visualization_jobs` (`schema.sql:59–60`) — confirming the "pre-release scaffold, no prod data to preserve" stance (`:56–57`).

### 4.2 Design highlights

- **Masks are files, not rows.** The comment at `schema.sql:98–100` explicitly chooses compressed PNGs on disk so undo snapshots and API payloads stay cheap.
- **Generated `hex_value`** keeps the frontend catalog row honest (`schema.sql:25–30`) — hex can never drift from r/g/b.
- **`updated_at TIMESTAMP(3)`** exists specifically because second-resolution timestamps make same-second PATCH conflict checks indistinguishable (`schema.sql:74–77`).
- Optimistic-concurrency guard implemented in `projects.model.js:63–71` (returns HTTP 409 on mismatch) and mirrored for layers (`projects.routes.js:30–31`).
- **`cover_asset_id` auto-set on first photo upload** so project cards render thumbnails without extra fetches (`assets.controller.js:24–29`; join in `projects.model.js:14–17`).

### 4.3 Minor schema/code inconsistencies

- `.env` uses `DB_NAME=paint_visualizer_pro` (`backend/.env:12`) while compose + schema init use `paint_visualizer` (`docker-compose.yml:9,28`; `schema.sql:4`) — a local-vs-compose drift that will break "point .env at the compose DB".
- `exports.controller.js:33` nests files under `uploads/projects/<id>/exports/...`, while assets/layers use bare `asset.id` folders (`assets.controller.js:20`). Both work and are served consistently, but the layout is inconsistent with the documented id-keyed convention (`assets.controller.js:14–16`).

---

## 5. AI cleanup pipeline

### 5.1 End-to-end flow (`POST /api/assets/:id/clean`)

1. `assets.routes.js:13` — `multer` memory storage, 25 MB cap, optional `mask` file (`upload.single('mask')`).
2. `assets.controller.js:51–76` (`requestCleanup`):
   - sets status `cleaning` (`:56`);
   - reads `original_path` from disk (sync) (`:58`);
   - forwards `(imageBuffer, optional maskBuffer)` to the provider dispatcher (`:61`);
   - saves result as `cleaned.jpg` and flips status to `cleaned` (`:66–68`);
   - on error, marks the asset `failed` with `error_message` (`:71–73`).
3. `aiProxy.service.js:14–25` — dispatch on `AI_PROVIDER` (default `clipdrop`). Providers are pluggable files; routes/controllers/frontend stay untouched (`:6–10`).

### 5.2 Provider wiring (current config)

`backend/.env:19` sets `AI_PROVIDER=huggingface`; the Clipdrop key is a placeholder (`:22`), so **HF is the only configured live path**:

- **HF router path** (`providers/huggingface.js`): model `fal-ai/fal-ai/flux-2/klein/9b/edit` at `https://router.huggingface.co/...` (`backend/.env:32–33`); `HF_INPUT_MODE=json`, `HF_JSON_SHAPE=image_urls` → payload is `{ prompt, image_urls: ["data:image/png;base64,…"] }` (`huggingface.js:43–62`). Response normalized from raw bytes or JSON wrapper with `images[].url` / base64 fields (`huggingface.js:106–142`), including a follow-up `fetchRemoteImage` download (`:95–104`).
- **Clipdrop path** (`providers/clipdrop.js:10–46`): multipart `image_file` (+ optional `mask_file`), `x-api-key` header; **this is the only provider path that actually uses the mask**.

### 5.3 Transport guarantees (`providers/httpClient.js`)

- 30 s request timeout via `AbortController` (`:12,37–52`);
- retries 429/503/504, max 2 attempts, exponential backoff `500·2^(n−1)` capped 4 s (`:13–14,33–35,74–114`);
- `ProviderError` always carries status/provider/model/request-id and the provider's error body (`:16–27,97–113`);
- structured logging of latency/status (`:81,85,93,101,106`).

### 5.4 ⚠️ Findings

1. **The user-drawn "remove this" mask is silently dropped in the active config.** `buildJsonPayload` only ever receives `imageBuffer` (`huggingface.js:43–62`); the mask is only attached in `multipart` mode (`:74–83`), which `.env` does not use (`HF_INPUT_MODE=json`, `backend/.env:35`). The controller advertises the mask as optional input (`assets.controller.js:59`) and the frontend sends it (`frontend/src/shared/lib/api.js:76–80`), but under the configured HF path it never reaches the model.
2. **Data-URI MIME mismatch:** `huggingface.js:60` hardcodes `data:image/png;base64,` while the uploaded source is stored as `original.jpg` (`assets.controller.js:21`). If the model validates the declared MIME against bytes, JPEG uploads may be rejected.
3. **30 s timeout vs. model latency.** The whole POST (including generation) is bounded by the 30 s timeout (`httpClient.js:12,77`). Image-edit models routinely take longer; a timeout aborts mid-generation and the asset is marked `failed` (`assets.controller.js:71–73`). Consider a longer, generation-aware budget.
4. **Real-looking HF API key committed to disk** — `backend/.env:30` (`hf_uJMIb…`), plus a second "burned" key in a comment (`:29`). The file is gitignored (`backend/.env` in `.gitignore`), so it is **not in git history**, but it is on this machine and must be rotated/removed before this folder is shared (§11.1).
5. **The `created_via` enum already anticipates `ai-surface`** (`schema.sql:106`) but no segmentation provider is wired — consistent with the README's explicit deferral (`README.md:58–60`).

---

## 6. Client image pipeline

### 6.1 Photo ingest

`useImageElement` (`canvas/useImageElement.js`) loads images with `crossOrigin='anonymous'` (`:20`) and **downscales to ≤1600 px** for canvas work (`:3,23–30`). Full-res stays on the server; exports re-render client-side at working resolution (`:5–7`).

### 6.2 Mask generation (pure JS, `tools/maskOps.js`)

All helpers return `ImageData` whose **alpha = selection strength**, the exact contract `colorEngine` reads:

- `createEmptyMask` (`:5`), `featherMask` via canvas `blur()` on the alpha channel (`:14–28`) — soft edges instead of "sticker" cutouts;
- `rasterizeRect` (`:30–43`), `rasterizePolygon` using the browser rasterizer (even-odd fill, `:48–59`);
- `rasterizeBrushStroke` — resampled (interpolated) input + quadratic mid-point smoothing + round caps + adaptive feather (`:66–134`);
- **`surfaceAwareBrushStroke`** (`:157–269`, uncommitted) — a region-growing "smart brush": seeds are only accepted where the local LAB-median matches the stroke pixel; a BFS flood fill then grows inside the stroke footprint gated by a coarse interpolated reference field (24 px cells), so the paint stops at railings/frames/glass/sky seams instead of bleeding through;
- `mergeMasks` union/subtract with proportional alpha erasure (`:306–317`);
- `floodFillMask` — magic-wand flood fill by LAB distance (`:322–352`);
- `imageDataToPngBlob` (`:354–360`).

### 6.3 Recolor engine (`shared/lib/colorEngine.js`)

- sRGB↔linear↔XYZ↔CIELAB; `applyPaintColor(imageData, maskData, targetRgb, strength, opts)` blends `a`/`b` toward the target while preserving the source's `L` by default — the "keeps it photorealistic" behavior (`:120–132` region; uncommitted diff).
- **Uncommitted improvements:** a 256-entry sRGB→linear LUT (identical output, no `Math.pow` per pixel), a cheaper `labL()` luminance-only path, and `lightnessBlend` — when >0, the masked region's mean lightness is shifted toward the paint's while each pixel's relative shading offset is preserved, making light paint over a dark wall read like an actual coat (`colorEngine.js` diff; consumed at `LayerNode.jsx:42–46` with `strength 0.95 / lightnessBlend 0.45` for painted layers, `0.35 / 0` for the unpainted preview tint `#2F5D8A`).

### 6.4 Layer compositing (`canvas/LayerNode.jsx`)

- One fresh `<canvas>` per recompute so Konva's Image node reliably redraws (`:13–16,48–52`);
- recompute only when this layer's mask/color changes — not on unrelated store updates (`:8–11`);
- **rAF-coalesced** recompute because catalog hover-preview can fire the effect many times/second and the LAB pass is the most expensive work the component does (`:24–29,55`);
- per-layer Konva opacity (`:65`); hidden layers return `null` (`:58`).

### 6.5 Suggestions (rule-based, not ML) — `shared/lib/colorSuggest.js`

- `extractContextColors` samples a sparse grid **outside** the active layer's actual mask (alpha ≤0.2 skipped, `:17–21`), quantizes to 24/step buckets, returns top-5 context colors (`:13–38`);
- `suggestColors` derives theory targets from the dominant context hue — complementary, ±analogous, monochrome — then scores the whole catalog by CIEDE-style LAB distance and de-dupes by `color_code` (`:82–118`);
- Documented as deliberately explainable/tunable instead of a black box (`:3–9`).

### 6.6 Comparison & export

- Four §8 modes (`side-by-side | slider | split | fade`) implemented in `panels/ComparisonPreview.jsx`.
- Client renders the composite on `<canvas>` and uploads it; `exports.controller.js` persists it as a job and returns `ready` immediately — there is no render worker (`exports.controller.js:9–13`). PDF returns a clear **501** rather than a silent downgrade (`:20–24`).

### 6.7 Undo/redo (command pattern)

`hooks/useHistoryCommand.js` — invertible command types, all mirrored to the persisted `/history` log so the stack survives refresh (`:6–9`):

| action | type | |
|---|---|---|
| `color-applied`, `opacity-changed`, `visibility-changed`, `lock-changed`, `order-changed`, `mask-edited`, `name-changed`, `finish-changed` | `patch` | `:25–33` |
| `mask-created` | `create` | `:34` |
| `layer-deleted` | `delete` (soft, same id/mask restored) | `:35` |
| `paint-cleared` | `bulk-delete` | `:36` |

---

## 7. API inventory

Auth note: **all of `/api/*` sits behind `requireAccessKey`** (`app.js:37`); `/health` and `/files/*` do not.

| Method | Path | Controller / behavior | Validation |
|---|---|---|---|
| GET | `/health` | `{status:'ok'}` (`app.js:39`) | — |
| GET/POST | `/api/catalog` | `paints.controller.js:4–15,25–38`; create 409 on dup `color_code` (`:31–34`) | Zod `paintSchema` (`:27`) |
| GET/PUT/DELETE | `/api/catalog/:id` | `:17–23,40–61`; delete = soft (`:58`) | Zod (`:45`) |
| POST | `/api/catalog/import/preview` | dry-run diff, no writes (`importExport.controller.js:4–10`) | manual |
| POST | `/api/catalog/import/commit` | upsert by `color_code`, duplicate strategy (`:12–25`) | manual |
| GET | `/api/catalog/import/export` | streams XLSX (loads ≤100k rows) (`:27–35`) | — |
| GET/POST | `/api/projects` | `projects.routes.js:9–18` | manual |
| GET/PATCH | `/api/projects/:id` | optimistic 409 (`projects.model.js:63–71`) | manual |
| GET/POST | `/api/projects/:projectId/assets` | upload (multer 25 MB, memory) (`assets.routes.js:7`; `assets.controller.js:8–33`) | manual |
| GET | `/api/projects/:id/history` · POST | `history.controller.js:19–23,6–17` | `action` required |
| GET/POST | `/api/projects/:id/concepts` | concepts | manual |
| GET/POST | `/api/projects/:id/exports` | PDF → 501 (`exports.controller.js:20–24`) | manual |
| GET/PATCH/DELETE | `/api/assets/:id` | rename / delete (+file cleanup +cover reassign, `assets.controller.js:90–119`) | manual |
| POST | `/api/assets/:id/duplicate` | copies original+cleaned bytes to new UUID folder (`:121–143`) | — |
| POST | `/api/assets/:id/clean` | AI proxy (§5) | — |
| POST/GET | `/api/assets/:id/layers` | create (mask optional) / list (`layers.controller.js:8–47`) | `createdVia` enum checked (`:17–19`) |
| PATCH/DELETE | `/api/layers/:id` · POST `/restore` | multipart-or-JSON patch coercion (`:65–74`); soft delete / restore (`:81–99`) | manual |
| GET | `/api/exports/:id` | `exports.controller.js:42–48` | — |
| GET | `/files/*` | static file serving, **no key** (`app.js:50–56`) | — |

**Rate limits:** 200 req / 15 min on `/api/projects/:projectId/assets` and `/api/catalog/import` only (`app.js:33–35`). No global or other-endpoint limiting.

**Pattern observations**
- `projects.controller.js` intentionally does not exist — `projects.routes.js` calls the model directly, and nested routers mount with `mergeParams` (`projects.routes.js:39–42`).
- SQL is fully parameterized; the dynamic PATCH `SET` clause is built from a hard-coded whitelist `FIELD_MAP` (`projects.model.js:48–55,76–78`).
- Validation is uneven: **Zod only on catalog CRUD**; everything else is manual `typeof`/presence checks.

---

## 8. Frontend architecture & state management

### 8.1 Routing (`src/app/App.jsx`)

`/` → redirect to `/dashboard`; `/dashboard`, `/projects`, `/catalog`; `/visualize` forces project creation (`VisualizeRedirect`); `/projects/:projectId/visualize` is the workspace. Sidebar provides the rail.

### 8.2 State layering (deliberately separated)

| Layer | Owner | Evidence |
|---|---|---|
| Server state (projects/assets/layers/history/concepts/exports) | **TanStack Query** | `queryClient.js:7–15` — `staleTime 10s`, `retry 1`, `refetchOnWindowFocus:false` |
| Ephemeral editor state (active tool/color/viewport/brush) | **Zustand** | `store/visualizerStore.js`; comment `queryClient.js:3–6` |
| Draft persistence (viewport/tool/active ids) | **IndexedDB** via idb-keyval, debounced 400 ms | `hooks/useIndexedDraft.js:6–10,29–33`; key `visualizer-draft:<projectId>` |
| Favorites / recently-used / collections | **localStorage** (per-browser, no auth) | `features/catalog/useFavorites.js` (keys `catalog-favorites`, `catalog-recently-used`), `useCollections.js` (`catalog-collections`, ids `col_…`) |

### 8.3 API client (`shared/lib/api.js`)

- `BASE_URL` from `VITE_API_BASE_URL` (`:1`); `x-api-key` sent only when `VITE_API_ACCESS_KEY` is set (`:2,9`);
- FormData built for uploads/masks/multipart PATCHes (`:24–34,76–80,86–99`);
- file URLs built as `${BASE_URL}/files/<relativePath>` (`:81`);
- ⚠️ `catalog.exportUrl()` (`:49`) returns a plain URL for browser navigation; because `/api/*` requires the `x-api-key` header, a plain `<a href>`/`window.open` download will receive a **401 when the key is configured** unless the frontend downloads via `fetch`+blob (verify `ExportPanel.jsx` wiring before relying on export).

### 8.4 Tools & shortcuts

`tools/toolDefs.js` — rect / lasso / polygon / magic-wand / brush (mask-edit + direct-paint) / eraser / eyedropper / pan, shortcuts `r l g m b e i h`. `useToolInteraction.js` drives pointer→rasterization, including the surface-aware brush toggle + tolerance in the store (uncommitted `surfaceAware/surfaceTolerance` in `visualizerStore.js`).

---

## 9. Feature-completeness matrix (README claims vs code)

| README claim (`README.md`) | Status | Evidence |
|---|---|---|
| Catalog CRUD + Excel import/export ✅ | ✅ verified | §7 |
| Project-centric IA (Dashboard/Projects/`/projects/:id/visualize`) ✅ | ✅ verified | §8.1; `projects.routes.js` |
| Konva layers-with-masks, live per-layer recolor ✅ | ✅ verified | `LayerNode.jsx`; `colorEngine.js` |
| Tools: rect, lasso, polygon, magic wand, brush, bucket fill, eyedropper ✅ | ⚠️ mostly — README lists 7; code has 8 incl. **eraser & pan**; "bucket fill" maps to `floodFillMask` (magic-wand) | `toolDefs.js`; `maskOps.js:322–352` |
| Undo/redo (command pattern) + scrubbable History tab ✅ | ✅ verified | `useHistoryCommand.js`; `history_entries` |
| Autosave + IndexedDB draft cache + conflict toast ✅ | ✅ verified (autosave server-side via PATCH w/ `updatedAt`; conflict 409 at `projects.model.js:63–71`) | §8.2 |
| Favorites/recently-used, hex-proximity search, hover-preview ✅ | ✅ verified (client-side; `useCatalogList` shares one cached 2000-row fetch) | `useFavorites.js`; `CatalogPage.jsx`; `LayerNode.jsx:24–29` |
| Layer-aware AI color suggestions ✅ | ✅ verified — **rule-based, not ML** | `colorSuggest.js` |
| Comparison modes + PNG/side-by-side-JPG export ✅ | ✅ verified | `ComparisonPreview.jsx`; `exports.controller.js:6` |
| Keyboard shortcuts, ARIA live status, responsive 3-pane/collapsed/read-only ✅ | ✅ verified | `Toolbar.jsx`, `SaveStatusIndicator.jsx`, `Sidebar.jsx` |
| AI cleanup proxy ⚠️ "needs a real provider API key" | ⚠️ **contradicted by disk state** — `.env:30` already holds a real-looking HF key; and the mask is dropped in the configured HF path (§5.4.1) | `backend/.env` |
| Deferred: RBAC, reports, AI surface selection, branded PDF | ✅ accurately listed as deferred, PDF returns 501 | `README.md:55–62` |

**Net:** README is an accurate description of the **working tree**, not of `main` (see §2.1). All "working" claims are backed by real code — this is not a vaporware scaffold.

---

## 10. Requirements coverage scoring (vs `v2.md`)

| `v2.md` area | Status | Notes / evidence |
|---|---|---|
| §3 project gate (visualizer only within a project) | ✅ | `VisualizeRedirect`; `projects.routes.js:37–42` |
| §5.2 mask pipeline (selection tools, mask-as-file) | ✅ | `maskOps.js`; `layers.controller.js:24–27` |
| §5.3 undo/redo persisted | ✅ | `history_entries`; `useHistoryCommand.js` |
| §6.1 hover-preview | ✅ | `LayerNode.jsx` rAF coalescing |
| §6.2 color suggestions (explainable) | ✅ | `colorSuggest.js` header `:3–9` |
| §6.3 AI cleanup (hosted proxy) | ⚠️ | wired, but mask dropped in HF json mode; key on disk; 30 s budget |
| §7 optimistic concurrency + draft cache | ✅ | `projects.model.js:63–71`; `useIndexedDraft.js` |
| §8 comparison modes + export | ✅ / ⚠️ | 4 modes + PNG/JPG ✅; PDF deferred 501 |
| §9 production readiness | ❌ | no tests/CI/lint; frontend container runs dev server; secrets on disk |
| §10 roles/RBAC | ⏸ deferred | documented product decision |
| §11 performance guidance (lazy/high-res, virtualization) | ⚠️ | downscale ✅; LUT/labL ✅ (uncommitted); no React-virtualized lists, 2000-row catalog fetched whole |

---

## 11. Security review

### 11.1 Critical

1. **Live API key on disk.** `backend/.env:30` contains a real-looking Hugging Face token; a previously "burned" key sits in a comment at `:29`. Gitignored (`backend/.env`), so not in git history — but **treat it as compromised if this machine/repo is shared; rotate it.** A key that bills usage to the owner's HF account (per the provider comment, `huggingface.js:6–9`) with no spend limit is a financial-exposure risk.

### 11.2 High

2. **`/files/*` is unauthenticated and path-aware.** Mounted outside `/api` (`app.js:37` vs `:50–56`), so every uploaded photo, every mask, and every export is readable by anyone who can reach the server and guess/know a path (obscurity = UUID folders + timestamps). If this ever leaves localhost, attach the same key guard (or signed URLs).
3. **Path-traversal guard can be bypassed by a sibling prefix.** `storage.service.js:19–26` checks `full.startsWith(UPLOAD_ROOT)`. Because `path.join` normalizes `..`, a request like `/files/..%2F..%2Fuploads-evil%2Fx.png` resolves to `…/uploads-evil/x.png`, whose absolute path **starts with** `…/uploads` → **accepted**, serving files from any sibling directory that shares the uploads prefix. Today nothing confidential lives there and paths are server-generated, but the `/files/*` route is attacker-controlled input to this function. Fix: verify with `path.relative` and reject any result starting with `..`, or compare against `UPLOAD_ROOT + path.sep`.
4. **Shared-key auth that silently disables itself.** `accessKey.middleware.js:8–12` passes requests when the key is unset or still the placeholder — fine for dev, catastrophic if a deploy forgets `.env`. Also the configured key `pv-local-dev-key-2026` (`backend/.env:4`) is an easily-guessable constant.

### 11.3 Medium / housekeeping

5. **No rate limiting on `/files/*`, catalog, projects, history, layers** — only upload/import (`app.js:33–35`). Browsing/enumeration endpoints are unprotected.
6. **No multer `fileFilter`** — any content-type accepted and stored as `original.jpg` / `cleaned.jpg` (`assets.routes.js:7`; `assets.controller.js:21`). Combined with `res.sendFile` (`app.js:54`) there is no MIME sniffing risk for HTML, but the stored-type/extension mismatch (§14) is a correctness gap.
7. **CORS `*` fallback** when `CORS_ORIGIN` unset (`app.js:28`); frontend's `x-api-key` from `VITE_API_ACCESS_KEY` would ship in the bundle (`api.js:2`), so the key is **not a secret from browser clients** — the real boundary is "who may reach the server".
8. **Helmet is active** with CORP `cross-origin` correctly configured so the canvas can read images cross-origin (`app.js:27`, comment explains the CORS-vs-CORP nuance). Default CSP/other headers apply.

### 11.4 Notes that turned out fine

- SQL is fully parameterized (`projects.model.js:76–78` uses placeholders; whitelist field map prevents column injection).
- `xlsx` import preview is a dry-run; commit only accepts the preview's `validRows` (`importExport.controller.js:12–25`).
- 25 MB upload cap + 2 MB JSON cap (`assets.routes.js:7`; `app.js:30`).
- Provider error bodies are truncated to 500 chars before logging (`httpClient.js:60–63`); the error handler logs `err.stack` only (`errorHandler.middleware.js:2`).
- `fetchRemoteImage` follows a URL returned by the **trusted provider** (`huggingface.js:95–104`) — not attacker-controlled, acceptable.

---

## 12. Performance review

**Good**
- Client-side LAB work is coalesced per animation frame (`LayerNode.jsx:24–29`) and isolated per layer — changing one color recomputes one layer, not the stage (`:8–11`).
- Downscale cap of 1600 px keeps canvas ops fast (`useImageElement.js:3`).
- Uncommitted: sRGB LUT (kills per-pixel `Math.pow`), `labL()` (≈⅓ the cost when only luminance is needed), sampled mean-lightness pass (every 3rd pixel) (`colorEngine.js` diff).
- Surface-aware brush bounds its BFS flood fill to a padded stroke bbox + a 24 px reference grid instead of the whole image (`maskOps.js:160–223`).
- TanStack `staleTime 10s` + `refetchOnWindowFocus:false` limit refetch churn (`queryClient.js:10–12`); cover paths joined server-side to avoid per-card fetches (`projects.model.js:14–17`).
- IndexedDB draft writes debounced 400 ms (`useIndexedDraft.js:29`).

**Concerns**
- **Synchronous `fs` on the request path** — `readFileSync`/`writeFileSync`/`existsSync` everywhere in `storage.service.js:28–54`, including inside upload and AI-clean handlers (`assets.controller.js:58,66`). With 25 MB uploads and a live HF call, the event loop blocks during every read/write; a multi-tenant deployment would stall under concurrent uploads/cleans.
- **Catalog list loads the whole table client-side** (~2000 rows fetched once and cached, then filtered in-browser, `useCatalogList` + `CatalogPage.jsx`), despite the API already supporting server-side `search/productLine/page/pageSize` (`paints.controller.js:6–12`).
- **Export streams 100k rows to memory + XLSX build synchronously** (`importExport.controller.js:29–30`).
- Hover-preview still runs a full per-layer LAB pass per distinct swatch (mitigated by rAF coalescing) — the largest remaining interactive cost at 1600² working resolution.
- No `React.memo`/virtualization for large History/layers lists (fine at expected scale).

---

## 13. Production readiness

| Area | Status | Evidence |
|---|---|---|
| Tests | ❌ **none** — no `*.test.*`, no `*.spec.*`, no test script in either package.json | glob + `package.json` |
| Lint / typecheck | ❌ none (no lint/typecheck scripts, no ESLint/TS config) | both `package.json` |
| CI/CD | ❌ none | no workflow files |
| Container story | ⚠️ **frontend container runs `npm run dev` (Vite dev server), not a production build** | `frontend/Dockerfile` `CMD ["npm","run","dev","--","--host"]` |
| Container hygiene | ⚠️ runs as root; no healthcheck (`/health` exists but unused, `app.js:39`); `npm install` not `npm ci` (no lockfile) | both Dockerfiles; `docker-compose.yml` |
| Secrets | ❌ real HF key in `backend/.env`; `API_ACCESS_KEY` guessable constant; compose DB password `change-me` | `backend/.env:4,30`; `docker-compose.yml:11,27` |
| Migrations | ⚠️ single additive `schema.sql` + idempotent ALTERs (`runSchema.js`); no versioned migrations, no rollback | §4 |
| Error handling | ⚠️ JSON error handler + morgan to console only; no aggregation/rotation (`errorHandler.middleware.js:2`; `app.js:29`) | — |
| Logging | ⚠️ provider logging is structured (`httpClient.js`) but app-level is `console.error` | — |
| Graceful shutdown / process mgmt | ⚠️ none (nodemon in dev only) | `backend/package.json:9` |
| Static asset serving (prod) | ❌ no static build output path served by backend; frontend has no reverse-proxy plan | `app.js` has no `express.static` |
| Backups / object storage | ⚠️ local disk only; comment flags S3/MinIO as a later move (§6.3) | `storage.service.js:1–7` |

**Bottom line:** consistent with a pre-release scaffold. To ship: tests + CI, prod build container, key rotation + env hardening, and the §11 fixes.

---

## 14. Bugs, discrepancies & placeholders

1. **AI mask dropped in HF json mode** — the configured `AI_PROVIDER=huggingface` + `HF_INPUT_MODE=json` never sends the user's cleanup mask (`huggingface.js:43–62` vs `:74–83`).
2. **`data:image/png` prefix on JPEG bytes** (`huggingface.js:60` vs `assets.controller.js:21`).
3. **Worktree ≠ commits** — README/surface-aware brush/lightness-blend/LUT/Tailwind plugin only exist uncommitted (§2.1).
4. **`/files/*` sibling-prefix traversal bypass** (§11.2.3).
5. **Catalog export URL can't send `x-api-key`** via plain navigation (`api.js:49`); returns 401 once a key is configured unless downloaded via fetch/blob.
6. **DB name drift** `paint_visualizer_pro` (`.env:12`) vs `paint_visualizer` (compose + schema).
7. **Exports double-nest** `uploads/uploads/projects/...` (`exports.controller.js:33`) vs id-keyed convention elsewhere — cosmetic but confusing for backups/reconcile.
8. **Stored type/extension mismatch** — everything saved as `.jpg` regardless of actual upload content (`assets.routes.js:7`, `assets.controller.js:21,66`).
9. **README tools list** omits eraser/pan and calls magic-wand "bucket fill" (§9) — documentation drift.
10. **`AI_PROVIDER` default is `clipdrop`** (`aiProxy.service.js:15`) but `.env` sets `huggingface`; a future deploy that forgets `.env` silently falls back to the unconfigured provider and fails with a `ProviderError` (`clipdrop.js:20–26`) — fails loudly, but the fallback default is a footgun.
11. **Uploads are accepted with no `fileFilter`** — a 25 MB PDF stored as `original.jpg` and later handed to HF (`.env` prompt expects a photograph) will produce garbage; `reconcileUploads.js` exists to re-link orphaned folders but the upload path never validates type.

---

## 15. File inventory (with citations)

### Backend (`backend/src`)
| File | Role / key evidence |
|---|---|
| `app.js` | middleware order, rate limits, `/files/*`, `/health` — `:27–56` |
| `server.js` | bootstrap |
| `config/db.js` | mysql2 pool |
| `middleware/accessKey.middleware.js` | shared-key guard, self-disable — `:7–18` |
| `middleware/errorHandler.middleware.js` | JSON errors, console log — `:1–5` |
| `routes/paints.routes.js`, `importExport.routes.js`, `projects.routes.js` (`:9–42`), `projectAssets.routes.js`, `assets.routes.js` (`:7–14`), `assetLayers.routes.js`, `layers.routes.js`, `exports.routes.js`, `projectExports.routes.js`, `history.routes.js`, `concepts.routes.js` | REST wiring |
| `controllers/paints.controller.js` | Zod catalog CRUD + 409 dup — `:25–38` |
| `controllers/assets.controller.js` | upload/cover (`:8–33`), clean (`:51–76`), delete cleanup (`:90–119`), duplicate (`:121–143`) |
| `controllers/layers.controller.js` | mask-as-file (`:24–27`), multipart patch coercion (`:65–74`), soft-delete/restore (`:81–99`) |
| `controllers/history.controller.js` | append-only — `:6–23` |
| `controllers/importExport.controller.js` | preview/commit/export — `:4–35` |
| `controllers/exports.controller.js` | 501 PDF (`:20–24`), sync job (`:32–38`) |
| `services/paints.model.js`, `paints.validation.js` | catalog persistence + Zod schema |
| `services/projects.model.js` | cover join (`:14–17`), optimistic 409 (`:63–71`) |
| `services/assets.model.js`, `layers.model.js`, `history.model.js`, `concepts.model.js`, `exports.model.js` | per-table persistence |
| `services/excelImport.service.js` | preview-diff / commit upsert / XLSX |
| `services/storage.service.js` | local disk, traversal guard (`:19–26`) |
| `services/aiProxy.service.js` | provider dispatch — `:14–25` |
| `services/logger.service.js` | structured provider logs |
| `services/providers/httpClient.js` | 30 s timeout, retries, ProviderError — `:12–14,71–117` |
| `services/providers/huggingface.js` | json/multipart/binary modes — `:43–89` |
| `services/providers/clipdrop.js` | multipart + mask — `:10–46` |
| `scripts/runSchema.js` | additive migration — `:25–49` |
| `scripts/reconcileUploads.js` | orphan-folder relinking |
| `sql/schema.sql` | full DDL — §4 |

### Frontend (`frontend/src`)
| File | Role |
|---|---|
| `app/App.jsx`, `app/Sidebar.jsx` | routing / rail |
| `shared/lib/api.js` (`:1–128`), `queryClient.js` (`:7–15`), `colorEngine.js`, `colorSuggest.js`, `cn.js`, `debounce.js`, `useMediaQuery.js` | plumbing |
| `shared/styles/tokens.css`, `tailwind.css` | Tailwind 4 theme |
| `features/visualizer/*` | workspace, redirect, store, tools, canvas, hooks, panels (see §6/§8) |
| `features/catalog/*` | CatalogPage, PaintCard, ImportModal, favorites/collections |
| `features/projects/*` | Dashboard, ProjectsList, CreateProjectModal, ProjectCover, statusBadge |
| `shared/ui/*` | Radix-based button/dialog/sheet/slider/tabs/toast/tooltip/confirmDialog |

### Root / infra
`README.md`, `v2.md`, `PROJECT_TECHNICAL_AUDIT_REPORT.md`, `AUDIT.md`, `backend/.env`, `backend/.env.example`, `frontend/.env.example`, `docker-compose.yml`, `frontend/Dockerfile`, `backend/Dockerfile`, `.gitignore` (correctly excludes `.env` and uploads).

---

## 16. Prioritized recommendations

**P0 — before anything is shared/deployed**
1. Rotate and remove the HF key in `backend/.env:30`; generate a fresh key into env/secrets management; never let this file leave the machine unencrypted.
2. Fix the `/files/*` sibling-prefix traversal (`storage.service.js:22`) — use `path.relative`, reject `..` results, and add the same key guard (or signed URLs) to `/files/*`.
3. Commit the working tree (surface-aware brush, lightness-blend recolor, LUT, Tailwind plugin, v2 README) so `main` matches the README, or stage it deliberately before handoff.

**P1 — correctness of the AI path**
4. Send the user mask in HF json mode (or document that mask is Clipdrop-only); align the data-URI MIME with the real bytes; raise the 30 s provider budget for image-edit models (§5.4).
5. Replace the `clipdrop` fallback default (`aiProxy.service.js:15`) with a hard error when `AI_PROVIDER` is unset, so a mis-configured deploy can't silently pick the wrong provider.

**P2 — production hardening**
6. Add tests (unit: `colorEngine`, `maskOps`, `excelImport`, `paints.model`; integration: one upload→layer→recolor→export flow) + a CI gate (lint, test, build). No test exists today (§13).
7. Fix the frontend Dockerfile to build (`vite build`) and serve static output (or reverse-proxy); add healthchecks; run as non-root; commit lockfiles and switch to `npm ci`.
8. Add multer `fileFilter` + MIME sniffing for uploads; stop hardcoding `.jpg` when bytes are PNG/WebP.
9. Make catalog export work under auth (fetch+blob or a signed/header-aware route) — `api.js:49`.
10. Align DB naming (`paint_visualizer_pro` vs `paint_visualizer`); reconcile the exports double-nesting (`exports.controller.js:33`).

**P3 — scale & ops**
11. Move storage off sync `fs` (async or stream) and eventually to S3/MinIO per the design note (`storage.service.js:1–7`).
12. Reconcile frontend client-side filtering with the API's server-side `search/page` params (`paints.controller.js:6–12`).
13. Add rate limits to `/files/*` and the remaining write endpoints; add structured app-level logging + request IDs; add graceful shutdown.

---

*Audit completed from source. Line citations refer to the current working tree (including uncommitted changes where noted). Sections marked "uncommitted" exist only in the worktree, not in `main` (`a5db303`).*
