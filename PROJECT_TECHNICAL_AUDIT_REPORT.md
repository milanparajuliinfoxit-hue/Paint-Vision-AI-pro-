# Paint Dealer Visualizer v2 — Enterprise Technical Audit Report

**Audit date:** 2026-08-03
**Repo root:** `C:\Users\Lenovo\Downloads\paint-visualizer (1)\paint-visualizer`
**Branch:** `main` (3 commits: `1d4bae0` scaffold → `3b27aca` "full implementaion of ai object removal and editing" → `a5db303` merge "uiEnhancement")
**Method:** 100% of source files, config, and documentation read and cross-referenced against `v2.md` (product/engineering spec) and `AUDIT.md` (2026-08-01 v1-era audit). Every claim below cites a `file:line`. This is an engineering audit, not a code review — it evaluates the product, architecture, security, performance, UX, and production readiness of the current v2 codebase.

> **⚠️ Note on `AUDIT.md`:** the existing audit describes the **v1** architecture (four-step wizard, `visualization_jobs`, `ImageCanvas.jsx`, `ColorSwatch.jsx`, `StepIndicator.jsx`, 5-table schema, "repo not git-initialized"). None of that exists in v2 — v2 retired those tables (`schema.sql:59-60`), replaced the wizard with the project-centric workspace, and the repo is a git repo. Treat `AUDIT.md` as historical context, not ground truth. All conclusions below were re-verified against the current code.

---

## 1. Executive Summary

**Verdict: a well-crafted, pre-release scaffold with a genuinely working core, not a shippable product.** The v2 refactor delivers the hard parts — a project-centric, layer/mask-based visualizer with client-side LAB recolor, persisted undo/redo, autosave, IndexedDB draft cache, and a clean Express/MySQL backend. But it is blocked from production by four P0 issues (one real correctness bug, two security exposures, one config gap) and dozens of P1/P2 gaps.

### What works (verified in code)
- **Client-side recolor engine** — correct CIE LAB implementation (`colorEngine.js`), masks first-class, live per-layer recolor with zero "Apply" clicks.
- **Command-pattern undo/redo** persisted per project (`history_entries`) and hydrated after refresh (`useHistoryCommand.js`).
- **Full project lifecycle UI** — Dashboard, Projects (grid/table), create modal, cover thumbnails, statuses, responsive 3-pane workspace.
- **Catalog CRUD + Excel import/export** with preview → diff → commit and duplicate strategy.
- **Autosave + IndexedDB draft cache** (`useIndexedDraft.js`, 400ms debounce) and non-blocking save indicator.
- **Modern engineering hygiene** — TanStack Query owns server state, Zustand owns ephemeral editor state, Radix/framer-motion UI, design tokens, keyboard focus styles, `prefers-reduced-motion`, optimistic layer updates with rollback, resilient error/empty/loading states everywhere.

### What blocks release (P0)
1. **Excel import transaction bug** — writes escape the transaction (see §7.1). **Actual correctness bug.**
2. **`/files/*` serves all uploaded images/masks/exports without authentication** (§6.2).
3. **Live Hugging Face API key on disk** in `backend/.env`; prior key was already burned (§6.1).
4. **Compose stack ships with a dead AI proxy and an open access key** — no `HF_*` or `API_ACCESS_KEY` env in `docker-compose.yml`; access-key middleware fails open (§6.3, §10).

### Scorecard
| Dimension | Score | Rationale |
|---|---|---|
| Architecture & design | 7/10 | Clean layering, correct state ownership, good abstractions; legacy outlier + dead code drag it down |
| Correctness & data integrity | 5/10 | P0 import bug; re-import of soft-deleted colors fails; optimistic-concurrency checks inert; unbounded mask files |
| Security | 4/10 | Live API key, unauth file serving, fail-open access key, SSRF-prone remote-image fetch, hardcoded DB creds |
| Performance | 6/10 | Fast client pipeline; export capped at 1600px; sync fs; N+1 import preview; unclamped `pageSize` |
| Scalability | 3/10 | No project pagination, no queue/worker, unbounded file accumulation, single-editor by design |
| UX & accessibility | 7/10 | Strong tokens/a11y/keyboard/mobile story; missing fullscreen, spray, hardness, documented swatch rail |
| Product completeness (v2.md) | 6/10 | Core visualizer complete; Reports/RBAC/AI-segmentation/PDF/Settings deferred |
| Production readiness | 3/10 | No tests/CI/lint, frontend runs Vite dev in Docker, no observability, no backup strategy |
| Code quality & maintainability | 7/10 | Modular by feature, commented, consistent; no lint/typecheck config, dead props/state |
| Testing | 1/10 | Zero tests anywhere |

**Overall production readiness: 3.4/10.** A strong foundation; roughly 6–10 weeks of focused engineering (not including RBAC/Reports) to reach a defensible MVP.

---

## 2. Scope & Method

**Coverage: 100% of repository files read**, including every backend module, every frontend component/hook/util, both Dockerfiles, compose, all env/config, `.gitignore/.gitattributes`, and the three docs (`README.md`, `v2.md` spec, `AUDIT.md`).

Verification techniques used: full-file reads with line anchors; `grep` across the repo to prove dead code (see §12); cross-checks against the spec's acceptance criteria (§14 of `v2.md`); manual trace of write paths (import, mask edits, exports, cleanup).

---

## 3. Architecture Overview

### 3.1 Topology
```
Browser (React 18 / Vite 5 / Konva)
  ├─ <canvas> LAB recolor, mask rasterization, compositing, export render
  │   (100% client-side pixel work; server never touches pixels)
  └─ REST ──▶ Express 4 backend ──▶ MySQL 8 (metadata, CRUD, history, jobs)
                     │                  + local disk /uploads (original/cleaned photos,
                     │                    mask PNGs, concept thumbs, export files)
                     └─ HTTP ──▶ Hosted AI cleanup (Clipdrop or Hugging Face router)
                                  (thin proxy; vendor key stays backend-only)
```

### 3.2 Stack
- **Backend:** Node ≥18 (uses `fetch`/`FormData`/`Blob`), Express 4.19, `mysql2/promise` pool (connLimit 10, queueLimit 0, `dateStrings: true`), `multer` memoryStorage, `xlsx`, `zod`, `helmet`, `cors`, `express-rate-limit`, `uuid`, `morgan`.
- **Frontend:** React 18.3, Vite 5, `react-konva`/`konva` 10, Zustand 5 (ephemeral editor state only), TanStack Query 5 (all server state; staleTime 10s, retry 1, refetchOnWindowFocus false), Radix primitives, `framer-motion` (modals/sheets only), `idb-keyval`, Tailwind 4, `lucide-react`, react-router 6.

### 3.3 Data model (`backend/src/sql/schema.sql`, fully read)
- `paints` — catalog (7 product-line booleans, `r/g/b`, generated `hex_value`, `is_deleted` soft delete, `uq_color_code` unique).
- `projects` — `name`, `client_name`, `reference_note`, `status` enum (draft/in_review/client_approved/archived), `cover_asset_id`, `tags` JSON, `updated_at TIMESTAMP(3)` (ms precision, explicitly for the conflict check).
- `assets` — UUID PK matching the on-disk folder, `project_id` FK **ON DELETE SET NULL** (deleting a project orphans its photo rows + files), `original_path`/`cleaned_path`, `status` enum, `error_message`, `exif_orientation` (captured but never exposed).
- `layers` — `mask_path`, `created_via` enum, `current_color_id` FK **ON DELETE SET NULL**, `opacity`, `finish_override`, `order_index`, `locked`, `visible`, `deleted_at` (soft delete so undo restores the same id/mask file).
- `history_entries` — append-only, `before_state`/`after_state` JSON, FK CASCADE on project delete.
- `concepts` — saved "looks": `thumbnail_path` + `layer_color_map` JSON.
- `export_jobs` — `format` enum (pdf/png/side-by-side-jpg), `comparison_mode` enum, `status` pending/ready/failed.
- v1 tables `visualization_jobs`/`job_results` are dropped (`schema.sql:59-60`).

### 3.4 Storage layout (verified against code + on-disk folders)
| What | Path (under `UPLOAD_ROOT`) | Where |
|---|---|---|
| Photos | `<assetId>/original.jpg`, `<assetId>/cleaned.jpg` | `assets.controller.js:65-66` |
| Layer masks | `uploads/<assetId>/masks/layer_<ts>.png` → **`uploads/uploads/<assetId>/masks/`** | `layers.controller.js:66-67` |
| Concept thumbs | `uploads/projects/<id>/concepts/concept_<ts>.png` | `concepts.controller.js` |
| Exports | `uploads/projects/<id>/exports/export_<jobId>.<ext>` | `exports.controller.js` |
- The mask path double-nests an `uploads` segment (`layers.controller.js:66` uses `path.join('uploads', asset.id, 'masks')` while `assets.controller.js:63-65` explicitly avoids it). This is the source of the legacy `backend/uploads/uploads/<uuid>/` folders that `reconcileUploads.js` (depth ≤ 2 walk) reconciles.
- All disk I/O is **synchronous** (`writeFileSync/readFileSync/unlinkSync`, `storage.service.js`); the path-traversal guard is a weak prefix check (`full.startsWith(UPLOAD_ROOT)`).

### 3.5 Backend route map (all mounted in `app.js`)
- `/api/catalog` (paints CRUD), `/api/catalog/import/*` (preview 10MB / commit / export), `/api/projects` (+ nested `assets` 25MB, `history`, `concepts` 10MB, `exports` 25MB), `/api/assets/:id` (+`/clean`, `/duplicate`), `/api/layers/:id` (+`/restore`, PATCH multipart 10MB), `/api/exports/:id`, `/health` (public), `/files/*` (static, **outside** the access-key middleware).
- Rate limit: 200 req/15min on `/api/projects/:projectId/assets` and `/api/catalog/import` only (`app.js:33-35`). Everything else is unthrottled.

---

## 4. File-by-File Analysis

### 4.1 Backend

| File | Verdict | Notes |
|---|---|---|
| `src/server.js` | ✅ | Bare `app.listen(PORT)`. |
| `src/app.js` | ✅/⚠️ | Correct assembly; **`/files/*` mounted outside `requireAccessKey`** (`app.js:50-56`) — see §6.2. `helmet({ crossOriginResourcePolicy: 'cross-origin' })` is correct and required for canvas/image loads. |
| `src/config/db.js` | ✅ | Pool from env; nothing to change. |
| `middleware/accessKey.middleware.js` | ⚠️ | **Fails open**: passes when `API_ACCESS_KEY` is unset or equals `change-me-long-random-string` (dev convenience that becomes a hole in prod/compose, which never sets it). |
| `middleware/errorHandler.middleware.js` | ⚠️ | No status mapping (always 500 unless `err.status`); `multer`/validation errors surface as 500s. |
| `routes/*` | ✅ | Thin, correctly wired; multer caps match (assets 25MB via `MAX_UPLOAD_MB`, layers/import/concepts 10MB). |
| `controllers/paints.controller.js` | ✅ | Zod validation, 409 on duplicate `color_code`, soft delete on DELETE (204). |
| `services/paints.model.js` | ✅/⚠️ | `list` = `LIMIT ? OFFSET ?` **unclamped** (`paints.controller.js` passes `Number(pageSize)` straight through); `findByColorCode` excludes `is_deleted=0` → **re-importing a soft-deleted color throws ER_DUP_ENTRY** (§7.3); no `updatedAt` optimistic check (not needed — catalog edits are single-operator). |
| `controllers/importExport.controller.js` + `services/excelImport.service.js` | ⚠️ | **P0 bug** in `commitImport` (§7.1). `previewImport` does per-row `await findByColorCode` (N+1) and a 100k-row export streams fine. `mapRow` deliberately skips the ambiguous Excel `id` column (documented assumption). |
| `controllers/projects.controller.js` + `services/projects.model.js` | ✅/⚠️ | `listProjects` has **no pagination**; `updateProject` has a correct 409 conflict check — but **no UI caller ever supplies `updatedAt`**, so the check is inert from the client (see §12). |
| `controllers/assets.controller.js` + `services/assets.model.js` | ✅ | `uploadAsset` creates the row first, saves file, then sets `original_path` + first-photo `cover_asset_id`. `requestCleanup` correctly transitions cleaning→cleaned/failed with `error_message`. `deleteAsset` is thorough: grabs mask paths **including soft-deleted layers**, deletes rows (FK cascade), re-points/clears the project cover, deletes original/cleaned/mask files, prunes empty dir. `duplicateAsset` copies original+cleaned into a fresh UUID but **does not copy layers** (spec-consistent: layers belong to an asset's edited state). |
| `controllers/layers.controller.js` + `services/layers.model.js` | ✅/⚠️ | Soft delete/restore preserves ids and mask files (correct undo semantics). **Each mask edit uploads a new PNG and never removes the previous one** (§7.5). `updateLayer` supports the `updatedAt` 409 check but the UI never passes it. |
| `controllers/history.controller.js` + `services/history.model.js` | ✅ | Append-only log; list ordered `created_at ASC, id ASC`. |
| `controllers/concepts.controller.js` + `services/concepts.model.js` | ✅ | Named looks with thumbnail; `layer_color_map` JSON parsed server-side. |
| `controllers/exports.controller.js` + `services/exports.model.js` | ✅/⚠️ | Job lifecycle `pending→ready` exists, but **the client renders and uploads the finished blob in the same request** — `markReady` fires immediately (`exports.controller.js:37`). No queue, no async progress, PDF → 501. See §8.4. |
| `services/aiProxy.service.js` | ✅/⚠️ | Clean dispatcher; provider switch on `AI_PROVIDER` (clipdrop/huggingface). |
| `providers/clipdrop.js` | ✅ | Multipart `image_file`+`mask_file`, `x-api-key`, raw Buffer return. |
| `providers/huggingface.js` | ✅/⚠️ | `readConfig` throws when `HF_API_KEY/HF_MODEL/HF_API_URL` are missing (good). `fetchRemoteImage` fetches a **model-returned URL with the Bearer key attached, no timeout/retry/size-cap** (§6.4). |
| `providers/httpClient.js` | ✅ | Solid: 30s timeout, 2 retries on 429/503/504, exponential backoff (≤4s), `ProviderError` with `requestId`. |
| `services/storage.service.js` | ✅/⚠️ | Sync ops; prefix-based traversal guard only. Single swap point for S3. |
| `services/logger.service.js` | ✅ | Structured single-line JSON; info→stdout, error→stderr. |
| `scripts/runSchema.js` | ✅ | Replaces DB name, multi-statement, additive `ALTER`s (incl. `updated_at TIMESTAMP(3)` precision upgrade). |
| `scripts/reconcileUploads.js` | ✅ | Dry-run by default; depth≤2 UUID walk; re-links orphans into a project with `ON DUPLICATE KEY UPDATE`. |
| `sql/schema.sql` | ✅ | Coherent v2 schema; FKs intentional (SET NULL / CASCADE choices documented inline). |

### 4.2 Frontend

| Area | Verdict | Notes |
|---|---|---|
| `app/App.jsx`, `app/Sidebar.jsx`, `main.jsx` | ✅/⚠️ | Routes wired (Dashboard/Projects/Catalog + `/projects/:id/visualize`); `activeColor` state is **dead** — passed to a `Sidebar` that accepts no props and renders no swatch rail (§12.1). |
| `features/visualizer/VisualizerWorkspace.jsx` | ✅ | The orchestrator: Original/Cleaned/Painted states, compare header, undo/redo shortcuts, mobile read-only mode (spec §12, intentional), Export dialog, tool-to-mask commit routing. |
| `canvas/CanvasStage.jsx` | ✅ | Konva Stage with viewport transform, space/pan, ctrl+scroll zoom, Fit/100%/zoom %, live tool-preview overlay, explicit loading/error/empty states. **No fullscreen toggle** (spec §5.1) and **no `.cache()`** layer caching (spec §11). |
| `canvas/LayerNode.jsx` | ✅ | Fresh canvas per recompute, `transparentOutsideMask`, strength 0.85 / 0.35 fallback. |
| `canvas/useImageElement.js` | ✅/⚠️ | `MAX_DIMENSION = 1600` downscale with `crossOrigin='anonymous'` — also the **export ceiling** (§8.1). |
| `tools/maskOps.js` | ✅ | Rect/polygon/brush rasterization via scratch canvas, `mergeMasks` add/subtract, LAB flood-fill magic wand, PNG blob export. Unit-testable pure functions. |
| `tools/useToolInteraction.js` | ✅ | Transient gesture state; tools resolve to masks on commit; bucket/eyedropper fire directly. |
| `tools/toolDefs.js` | ✅/⚠️ | 9 tools (rect/lasso/polygon/magic-wand/brush/bucket/eraser/eyedropper/pan), shortcuts `r l g m b k e i h`. **No Spray** (spec §5.1), no AI-surface tool (deferred). |
| `store/visualizerStore.js` | ⚠️ | Well-scoped editor state; **two dead fields** `compareMode` and `inProgressMaskCanvas` (§12.2). |
| `hooks/useHistoryCommand.js` | ✅ | Command pattern with 4 types (patch/create/delete/bulk-delete), persisted to `history_entries`, hydrated on load, replay-based `jumpTo`. |
| `hooks/useLayers.js` | ✅/⚠️ | Optimistic PATCH with rollback; delete/restore are **not** optimistic (row disappears after server round-trip). |
| `hooks/useIndexedDraft.js` | ✅ | `idb-keyval` draft cache, 400ms debounce, keyed by project. |
| `hooks/useApplyColor.js`, `useAssets.js`, `useHistoryEntries.js` | ✅ | Thin, correct query/mutation hooks. |
| `panels/ExportPanel.jsx` | ✅/⚠️ | 4 comparison modes; client-side composite re-derivation; uploads finished blob; PDF option disabled ("coming soon"). See §8. |
| `panels/ComparisonPreview.jsx` | ✅ | side-by-side / slider / split / fade with `clipPath` + range input. |
| `panels/AssetsTab.jsx` | ✅ | Upload/clean/rename/duplicate/delete; Originals/Cleaned/Masks/Painted/Exports sections; broken-file placeholders; cleanup failure keeps the original usable. |
| `panels/LayersTab.jsx`, `Inspector.jsx`, `Toolbar.jsx`, `HistoryTab.jsx` | ✅ | Layer vis/lock/order/delete/clear-all; brush size + mask-mode (no hardness); keyboard shortcuts; history paging (PAGE_SIZE 40). |
| `panels/SidePanel.jsx` + 8 tabs | ✅ | Assets, Layers, History, AI Suggestions, Catalog, Favorites, Brands, Finishes, Collections. |
| `panels/AISuggestionsTab.jsx` | ✅ | Rule-based suggestions sampling **outside** the active mask — the v1 sampling bug is fixed. |
| `features/catalog/CatalogPage.jsx` | ⚠️ | **Legacy outlier**: no react-query, inline style objects, native `confirm()`, client-side hex proximity over a 1000-row pull. Also the **Export link is broken when a real access key is configured** (§6.5). |
| `features/projects/*` (Dashboard, List, Modal, Cover, Badge, hooks) | ✅ | Good IA; statuses filterable but **no status-change UI anywhere** (§12.3). |
| `shared/lib/api.js` | ✅ | `request` wrapper (FormData-aware, `x-api-key`, 204→null, json/blob); `fileUrl` = `/files/<path>`. |
| `shared/lib/colorEngine.js` | ✅ | Correct sRGB↔linear↔XYZ↔CIELAB; `applyPaintColor` preserves per-pixel luminance while pulling a/b toward target (photorealistic). |
| `shared/lib/colorSuggest.js` | ✅ | `extractContextColors` (24/channel quantization, outside-mask) + `suggestColors` (complementary/analogous/mono targets, LAB ranking, dedupe by color_code). |
| `shared/ui/*` | ✅ | Radix-based Button/Dialog/Sheet/Tabs/Slider/Toast/Tooltip + ConfirmDialog/InputDialog (replace `window.confirm`/`prompt`). |
| `shared/styles/*` | ✅ | "Mixing room" tokens, `:focus-visible`, thin scrollbars, checkerboard, skeleton shimmer, `prefers-reduced-motion`. |

### 4.3 Infrastructure & docs

| File | Verdict | Notes |
|---|---|---|
| `docker-compose.yml` | ⚠️ | No `API_ACCESS_KEY`, no `HF_*` env → **fail-open access + dead AI cleanup** in the composed stack (§10). Hardcoded `change-me` DB passwords. Frontend is a **Vite dev server**, not a production build. DB name differs from local dev (`paint_visualizer` vs `paint_visualizer_pro`). |
| `backend/Dockerfile`, `frontend/Dockerfile` | ⚠️ | `node:20-alpine`; backend `npm install --omit=dev` + `mkdir /data/uploads` (matches compose `UPLOAD_ROOT`); frontend `CMD ["npm","run","dev","--","--host"]`. |
| `backend/.env` / `.env.example` | ⚠️ | **Live `HF_API_KEY` on disk** (§6.1). Env examples are well documented (Clipdrop + HF variants). |
| `frontend/.env` / `.env.example` | ✅ | `VITE_API_ACCESS_KEY` wired to `api.js`. |
| `README.md` | ✅ | Accurate "what's implemented" vs "deferred" — honest about the AI key and PDF 501. |
| `v2.md` | ✅ | Full spec, used as the reference model in §5. |
| `.gitignore` / `.gitattributes` | ✅ | Env, uploads, node_modules ignored; `eol=lf`; binaries marked. |
| `image.png` (untracked, ~1 MB) | — | Unattributed artifact at repo root (likely a screenshot); should be removed or documented. |

---

## 5. Feature Matrix vs. v2.md Spec

| Spec § | Feature | Status | Evidence |
|---|---|---|---|
| §3 | Dashboard (stats, "continue where you left off", quick-create) | ✅ | `DashboardPage.jsx` |
| §3 | Projects list (search, status filter, grid/table) | ✅ | `ProjectsListPage.jsx` |
| §3 | Visualizer scoped to project; `/visualize` redirect | ✅ | `App.jsx` + `VisualizeRedirect.jsx` |
| §3 | Reports, Settings | ❌ Deferred | README "explicitly deferred" |
| §4 | Project/Layer/Asset/History/Concept/ExportJob schema | ✅ | `schema.sql` (with spec-aligned comments) |
| §4 | `createdBy` on Project; layer `locked/visible` | ⚠️ | `createdBy` absent; `locked`/`visible` present + UI toggles |
| §5.1 | Fullscreen toggle | ❌ Missing | Not in `CanvasStage.jsx`/`Toolbar.jsx` |
| §5.1 | Persistent zoom control (fit/100%) | ✅ | `CanvasStage.jsx:236-242` |
| §5.1 | Tabbed left panel (Assets/Layers/History/AI) | ✅ | `SidePanel.jsx` |
| §5.2 | Selection→mask→layer; bucket fill; brush mask-edit + direct-paint | ✅ | `useToolInteraction.js`, `VisualizerWorkspace.jsx:116-162` |
| §5.2 | **Spray tool** | ❌ Missing | `toolDefs.js` (9 tools, no spray) |
| §5.2 | AI Surface Selection | ❌ Deferred | README |
| §5.3 | Command-pattern undo/redo, persisted | ✅ | `useHistoryCommand.js` |
| §6.1 | Cards, favorites, recently-used (last 8), hex proximity, hover preview (<100ms) | ✅ | `CatalogTab.jsx`, `useFavorites.js`, `colorSuggest.js` |
| §6.2 | Layer-aware AI suggestions | ✅ | `AISuggestionsTab.jsx` (samples outside active mask) |
| §7 | Autosave debounced + save indicator + conflict check | ✅/⚠️ | `useIndexedDraft.js`, `SaveStatusIndicator.jsx`; conflict check exists but is never triggered by the UI (§12) |
| §7 | IndexedDB draft cache (refresh-safe) | ✅ | `useIndexedDraft.js` |
| §8 | Comparison modes (side-by-side/slider/split/fade) | ✅ | `ComparisonPreview.jsx` |
| §8 | Export PNG / side-by-side JPG; **PDF with branding** | ⚠️/❌ | PNG/JPG ✅; PDF → 501 + disabled option |
| §8 | Export as **async job with progress, keep editing** | ❌ | Client-rendered + synchronous upload (§8.4) |
| §10 | RBAC (Rep/Manager/Admin) | ❌ Deferred | README |
| §11 | TanStack/Zustand boundaries | ✅ | Verified throughout |
| §11 | Konva layer caching | ❌ | No `.cache()` anywhere |
| §11 | Downscale for editing, **full-res for export** | ❌ | Full-res never used for export (§8.1) |
| §12 | Keyboard access (tool shortcuts, arrow cards, Enter apply) | ✅ | `toolDefs.js`, `CatalogPage.jsx:72-86`, `LayersTab.jsx` |
| §12 | ARIA live save/export status | ✅ | `SaveStatusIndicator.jsx` |
| §12 | WCAG AA chrome contrast; reduced motion | ✅ | `tokens.css` |
| §12 | Breakpoints: ≥1280 3-pane, 768–1279 collapse, <768 read-only | ✅ | `VisualizerWorkspace.jsx:60,300-319` |
| §13 | Reports (catalog usage, funnel, export activity) | ❌ Deferred | README |
| §14 | Refresh-restores-everything acceptance | ✅ | Draft cache + persisted layers/history |
| §15 | v1→v2 migration of legacy data | ⚠️ | `reconcileUploads.js` handles orphaned uploads; no wizard-session migration needed (v1 had no persistence) |

**Spec deltas that are silently missing (not documented as deferred):** fullscreen toggle, spray tool, brush hardness slider, Konva `.cache()`, and the sidebar swatch rail. Everything else missing is explicitly called out in the README.

---

## 6. Security Findings

Severity: **P0** = must fix before any public deployment · **P1** = fix before scale · **P2** = harden.

### 6.1 P0 — Live Hugging Face API key on disk
`backend/.env` contains `HF_API_KEY=hf_…REDACTED…`, `HF_MODEL=fal-ai/fal-ai/flux-2/klein/9b/edit`, `HF_API_URL=https://router.huggingface.co/fal-ai/fal-ai/flux-2/klein/9b/edit`. The file is gitignored (good), and a commented-out **`{burned}`** old key in the file proves at least one key has already leaked through this repo. This model is billed to the HF account (per `.env.example` notes: "HTTP 402 when monthly credits depleted"). **Action: rotate the key now; move all secrets to a vault/CI secret; never store real keys in a working copy that gets packaged, archived, or copied.**

### 6.2 P0 — `/files/*` serves every stored image without authentication
`app.js:50-56` mounts `GET /files/*` **outside** `app.use('/api', requireAccessKey)` (`app.js:37`). Every uploaded photo, AI-cleaned image, layer mask, concept thumbnail, and export is publicly readable by URL. This route is load-bearing — `api.js:81` (`fileUrl`) feeds every `<img>`/canvas source. Fine for a LAN internal tool; a hard blocker if this ever reaches the public internet (spec §10 intends multi-rep access). **Action:** protect the route (or sign expiring URLs); at minimum document the decision.

### 6.3 P1 — Access key fails open; compose never sets it
`accessKey.middleware.js`: requests pass when `API_ACCESS_KEY` is **unset** or equals `change-me-long-random-string`. `docker-compose.yml` sets no `API_ACCESS_KEY`, so the composed backend is wide open. The placeholder-pass-through is the exact failure mode that ships a public box with no auth.

### 6.4 P1 — Model-returned URL is fetched with the API key attached (SSRF-ish)
`huggingface.js:95-104` (`fetchRemoteImage`): when the provider responds with JSON containing `images[0].url`, the server `fetch`es that URL with `Authorization: Bearer <HF key>` and returns the bytes. A compromised/hijacked model endpoint (or MITM of the HF response) could point this at an internal service; the request would carry the HF bearer token and the response would be buffered unbounded (no timeout — this inner fetch bypasses `httpClient.post`'s 30s/retry — no size cap). **Action:** validate the URL scheme/host, drop the auth header on the download, add timeout + size cap, or require providers to return base64 only.

### 6.5 P1 — Catalog "Export" link is broken whenever a real access key is set
`CatalogPage.jsx:97` renders `<a href={catalog.exportUrl()}>Export</a>` where `exportUrl()` = `${BASE_URL}/api/catalog/import/export` (`api.js:49`). A plain anchor cannot attach the `x-api-key` header. With the current `backend/.env` (`pv-local-dev-key-2026`) the GET is rejected by `requireAccessKey` → **401**. (It only "works" in the fail-open placeholder/compose config.) **Action:** fetch as blob with the header, or add a short-lived signed export token.

### 6.6 P2 — Hardcoded DB credentials in compose
`docker-compose.yml:8-11` — `MYSQL_ROOT_PASSWORD: root_change_me`, `MYSQL_USER: paint_app`, `MYSQL_PASSWORD: change-me`; backend env repeats `change-me`. The MySQL port is also published to the host (`3306:3306`).

### 6.7 P2 — Weak path-traversal guard + sync fs
`storage.service.js` guard is `full.startsWith(UPLOAD_ROOT)` (a `/files/../uploads/...` or sibling-prefix trick could slip through prefix checks); `absolutePath` should `path.resolve` + require containment. Sync I/O on the request path also makes the API vulnerable to event-loop stalls (§8.2).

### 6.8 P2 — No rate limiting on the AI cleanup endpoint
Only assets-upload and catalog-import are throttled (`app.js:33-35`). `/api/assets/:id/clean` forwards to a **billed** hosted model with no per-IP/per-user throttle — a loop or bot can burn the HF credit balance.

### 6.9 P2 — Error messages leak internals
`errorHandler.middleware.js` returns the raw `err.message` (includes multer errors, DB errors, provider error details) to clients; provider errors also log the response body (`httpClient.js:106`).

---

## 7. Correctness & Data-Integrity Findings

### 7.1 P0 — Excel import transaction does not wrap the writes (the one real bug, confirmed in v2)
`excelImport.service.js:55-98`:
```
const conn = await pool.getConnection();   // 56
await conn.beginTransaction();             // 62
for (...) { paintsModel.create/update(...) }   // 71, 75, 78  ← uses the SHARED pool (autocommit)
await conn.query(import_log...);           // 83-87  ← the only statement on conn
await conn.commit();                       // 89
catch { await conn.rollback(); }           // 90-92  ← rolls back import_log only
```
`paintsModel.create/update` (`paints.model.js`) query the pool, so every paint row autocommits. A failure mid-loop leaves the catalog **half-written** while the rollback only discards the `import_log` row. Fix options: (a) run the INSERT/UPDATE SQL directly against `conn` in this service, (b) add a `conn` parameter to the model methods, or (c) batch single `INSERT ... ON DUPLICATE KEY UPDATE` statements (also fixes the N×1 latency).

### 7.2 P0 — No transaction around import at all for the write path — combined with 7.3, imports can corrupt
See 7.1 (rollback is illusory) and 7.3 (the loop can throw mid-commit after earlier rows already committed).

### 7.3 P1 — Re-importing a soft-deleted color crashes the import
`paints.model.findByColorCode` returns null for `is_deleted=1` rows (`paints.model.js:72-78`), so `previewImport` classifies the row as `create`; `commitImport` then calls `paintsModel.create` → `uq_color_code` duplicate → `ER_DUP_ENTRY` → the whole import fails (and, per 7.1, leaves earlier rows committed). **Action:** treat soft-deleted matches as `update` (restore + overwrite) or upsert.

### 7.4 P2 — Optimistic-concurrency checks are inert
`projects.model.js:57-71` and `layers.model.js:53-74` implement the spec's §7 conflict check (409 on `updatedAt` mismatch), and `updated_at` is `TIMESTAMP(3)` precisely for this. But **no UI caller passes `updatedAt`** (verified: `useProjects.js:30` and `useLayers.js:26` accept it; every call site — Inspector opacity/name/finish, LayersTab toggles, `handleCommitMask` — omits it). The "conflict toast" the README implies is therefore unreachable in practice. Single-editor scope makes this low-risk today; it must be wired before multi-editor.

### 7.5 P2 — Unbounded mask-file accumulation
Every brush/mask edit uploads `layer_<ts>.png` (`layers.controller.js:67`) and the previous file is deliberately kept (so undo can re-point `mask_path` without re-upload — a sound design in `useHistoryCommand.js:99-106`). But nothing ever sweeps superseded mask files. A long editing session grows an asset's folder without bound; only asset deletion (`assets.controller.js:112-115`) removes them. **Action:** a periodic sweep (retain current + one-undo-deep, or cap per asset) or reference-counted cleanup on history truncation.

### 7.6 P2 — `deleteAsset` misses the export/concept files
Asset deletion cleans photos + masks and fixes the cover, but concept thumbnails and export files for the project are left on disk (they belong to `projects/` paths, not the asset folder). Project deletion doesn't exist at all (no endpoint) — so `uploads/projects/.../exports|concepts` accumulate forever with no lifecycle owner.

### 7.7 P2 — No pagination on `listProjects` and unclamped `paints.list`
`projects.model.js:27-45` returns the full table (ORDER BY `updated_at`); `paints.controller.js` passes `Number(pageSize)` straight into `LIMIT ?` with no clamp or NaN guard. Fine at small scale; both will bite as the catalog (and the 100k-row export path) grows.

---

## 8. Performance & Scalability Findings

### 8.1 Export resolution is capped at the editor size (full-res never used)
`useImageElement.js` downscales everything to `MAX_DIMENSION = 1600`; `VisualizerWorkspace.jsx:76-84` derives `baseImageData` from that; `ExportPanel.jsx:33-71` and every layer composite render from it. The spec (§11) explicitly required "downscale for on-screen editing, keep full-res reference for export." Result: a 12 MP client photo exports as ≤1600px, and the **side-by-side JPG mixes a full-res original with a ≤1600px painted half** (`ExportPanel.jsx:135-147`) — visibly lower resolution and mismatched sizes in a "client-ready" deliverable. This is the biggest product-quality gap. **Action:** a render-worker path (Web Worker or server-side canvas) that composites against the full-res `original.jpg`.

### 8.2 Synchronous disk I/O on the request path
All `saveBuffer/readFile/deleteFile` are `fs.*Sync` (`storage.service.js`). Under the documented 25MB upload cap, each upload + each cleanup call (reads original, writes cleaned) blocks the event loop. For a single-user LAN tool this is fine; for the composed/prod shape it's a latency + memory (multer buffers files in RAM) concern.

### 8.3 N+1 in import preview
`previewImport` awaits `paintsModel.findByColorCode` per row (×1000s of rows) — a round trip each. Batch into `WHERE color_code IN (...)`.

### 8.4 Export job lifecycle is not async
Spec §8 wanted a background job with progress so the user keeps editing. Implementation: the composite renders in a (modal) dialog on the main thread; the finished blob is uploaded in the same request; the server `markReady`s immediately (`exports.controller.js:37`). The `pending` state is never meaningfully observed. For 1600px work this is fast enough today, but it is architecturally the wrong shape for the promised PDF/render-worker path.

### 8.5 Catalog browse pulls 1000 rows for hex-proximity/favorites
`CatalogPage.jsx:37` fetches `pageSize: 1000` and sorts client-side. At catalog scale (Excel-imported thousands of SKUs) this is a per-keystroke payload. Acceptable now; plan a server-side hex-distance endpoint.

---

## 9. UX & Accessibility Findings

**Strengths (verified):** strong design-token system ("mixing room" — chrome stays quiet, paint is the color); `:focus-visible` everywhere; `prefers-reduced-motion` honored; ARIA live save status; full keyboard path for tool selection (single-letter shortcuts), layer listbox (Enter/Space), and arrow-key catalog grid navigation; responsive breakpoints implemented exactly as the spec's intentional constraint (<768px read/compare-only with an explicit message, not silent breakage); broken-image placeholders ("Unreadable file" / "Photo couldn't be loaded"); single-undo-per-opacity-gesture; undoable clear-all; tooltips on all icon buttons.

**Gaps:**
- **The signature "swatch rail" is documented but absent** (§12.1): `tokens.css:1-7` calls it "the signature element"; `App.jsx` holds `activeColor` and both `CatalogPage` and `VisualizerWorkspace` call `onColorFocus`; but `Sidebar.jsx` takes no props and renders nothing. The rail (a vertical strip always showing the active color) was built in v1 and **regressed in v2**.
- **No fullscreen toggle** (spec §5.1) — present in v1 (`AUDIT.md` lists `Fullscreen` UI), absent in v2.
- **No spray tool and no brush hardness slider** (spec §5.1) — only brush size + mask-mode.
- **Catalog page is the UI outlier**: native `confirm()`, inline styles, no loading skeletons, no react-query caching — inconsistent with the rest of the app and with the spec's "no silent failures."
- **Statuses are read-only** (§12.3): statuses are filterable and badged but nothing can ever change a project's status (no status-setter UI), and `reference_note` (schema + model) has no UI at all.
- Minor: layer reorder emits **two** undo steps (`LayersTab.jsx:22-23`); export dialog's "editing stays available while this renders" (`ExportPanel.jsx:98`) is aspirational — the Radix dialog is modal.

---

## 10. Production Readiness & DevOps

- **No tests** (unit, integration, or e2e) anywhere in the repo. **No lint/typecheck config.** **No CI.**
- **Container frontend is a Vite dev server** (`frontend/Dockerfile`: `npm run dev -- --host`), not `vite build` + static serve — slower, exposes the dev toolchain, and is not a production posture.
- **Composed backend cannot run AI cleanup** — no `HF_*`/`CLIPDROP_*` env in `docker-compose.yml`, and `.env` is not copied into the image, so `huggingface.readConfig()` throws "HF_API_KEY is missing" on every cleanup call.
- **Compose backend has no `API_ACCESS_KEY`** → access-key middleware passes everything (§6.3).
- **Database name split-brain**: local dev uses `paint_visualizer_pro` (`backend/.env`), compose uses `paint_visualizer` (schema initdb + `DB_NAME` env). The `mysql` service mounts `schema.sql` as `docker-entrypoint-initdb.d` (only runs on an empty volume); `runSchema.js` handles upgrades separately.
- **No migration versioning** — `runSchema.js` is a best-effort additive script (create-if-not-exists + ALTERs + a fixed list of column upgrades with `ER_DUP_FIELDNAME` tolerance). No schema version table, no down migrations, no ordering contract.
- **No observability**: morgan + structured JSON logs only; no request IDs propagated to the client, no error tracking, no metrics.
- **No backup strategy** for MySQL or the `uploads` volume; no restore runbook.
- **Observations that are good:** `.gitignore` covers secrets/uploads; `.gitattributes` normalizes `eol=lf`; the reconcile script gives an operator an idempotent way to heal orphaned uploads; the README's "explicitly deferred" list is honest.

---

## 11. Code Quality & Maintainability

- **Modular by feature** (`features/visualizer|catalog|projects`), not by type — matches spec §11.
- **Correct state ownership**: TanStack Query owns server data; Zustand owns ephemeral editor state; the spec's rule is respected (the only misfit is the `visualizer-draft` IDB cache, which mirrors Query data — acceptable and documented).
- **Excellent inline documentation** — the codebase consistently explains *why* (e.g., `useHistoryCommand.js:10-24` documents the previous implementation's flaw; `tokens.css` explains the design direction; `schema.sql` comments explain every FK decision).
- **Friction points:** `CatalogPage.jsx` (legacy patterns), inline `rgbToHex` duplicates across files, dead code (§12), no lint/typecheck, `react-konva` requires eslint-disable comments (`CanvasStage.jsx:53`), two `ImageData`-decoding helpers duplicated (`VisualizerWorkspace.jsx:399-414` and `ExportPanel.jsx:149-157`).

---

## 12. Dead Code & Inert Features (grep-verified)

1. **Sidebar swatch rail** — `activeColor`/`onColorFocus` are threaded through `App.jsx`, `CatalogPage.jsx`, `VisualizerWorkspace.jsx` and call `rgbToHex` on every pick (`VisualizerWorkspace.jsx:101`), but `Sidebar.jsx` accepts no props and renders no rail. Full dead chain.
2. **`compareMode` + `inProgressMaskCanvas` in `visualizerStore.js`** — the only file referencing them (lines 31/40/57/58). `compareState` is alive and correct; these two are vestigial.
3. **`useUpdateProject`** — defined (`useProjects.js`) with zero call sites. Consequently **no project status-change UI exists** even though statuses ship end-to-end (schema → badge → filters).
4. **Project/layer `updatedAt` 409 conflict checks** — implemented server-side and threaded through the API client and mutation hooks, but never supplied by any component (§7.4).
5. **`reference_note`** — schema + model + FIELD_MAP only; no UI reads or writes it.

---

## 13. Placeholder & Deferred Inventory

- **Placeholders with real values on disk:** `backend/.env` `HF_API_KEY` (live), `pv-local-dev-key-2026`, `change-me` DB creds. Examples use `change-me-long-random-string` / `replace-with-real-key`.
- **Stubbed-but-honest:** PDF export = disabled `<option>` + backend 501 ("not a silent downgrade" — README); AI Surface Selection / RBAC / Reports / Settings explicitly deferred, **no stubbed code** (README: "not stubbed, not silently faked" — verified).
- **Untracked root artifact:** `image.png` (~1 MB) — remove or document.

---

## 14. Scoring (per-dimension detail)

| Dimension | Score | Key evidence |
|---|---|---|
| Architecture & design | 7 | Correct layering/state ownership; legacy CatalogPage + dead code |
| Correctness & data integrity | 5 | §7.1 P0; §7.3 import edge; §7.4 inert checks |
| Security | 4 | §6.1–6.6 |
| Performance | 6 | Fast client pipeline; §8.1 cap; §8.2 sync fs; §8.3 N+1 |
| Scalability | 3 | No project pagination, no queue, unbounded files, single-editor |
| UX & accessibility | 7 | Strong a11y; missing fullscreen/spray/hardness/swatch rail |
| Product completeness | 6 | Core done; Reports/RBAC/segmentation/PDF deferred |
| Production readiness | 3 | No tests/CI/lint, dev-server container, dead compose AI, no backups |
| Code quality | 7 | Feature modules, strong docs, no lint config |
| Testing | 1 | Zero tests |

---

## 15. 90-Day CTO Roadmap

### Phase 0 — Hardening (Week 1; unblocks any deployment)
1. Rotate `HF_API_KEY`; move secrets to env/CI/vault; scrub `{burned}` comment. *(P0, §6.1)*
2. Fix `commitImport` to write through the transaction connection (+ batch upsert). *(P0, §7.1)*
3. Protect `/files/*` (sign URLs or behind access key; at minimum document). *(P0, §6.2)*
4. Set real `API_ACCESS_KEY` in compose; stop fail-open on placeholder. *(P1, §6.3)*
5. Harden `fetchRemoteImage` (validate host, drop bearer on download, timeout + size cap). *(P1, §6.4)*
6. Fix the catalog Excel Export link (fetch-as-blob). *(P1, §6.5)*
7. Handle soft-deleted rows on Excel re-import (restore+update). *(P1, §7.3)*

### Phase 1 — Product quality (Weeks 2–4)
8. Full-resolution export pipeline (Web Worker composites from full-res `original.jpg`; parity with on-screen). *(§8.1)*
9. Async export worker + job progress + poll/status in UI (keep editing while exporting). *(§8.4)*
10. Wire `updatedAt` into layer/project PATCHes from the UI; surface the conflict toast. *(§7.4)*
11. Mask-file retention sweep (keep current + undo-deep per asset). *(§7.5)*
12. Project delete + archive lifecycle; clean up project-scoped concept/export files. *(§7.6)*
13. Restore the sidebar swatch rail (documented signature feature) + fullscreen toggle + spray/hardness if in scope. *(§12.1, §5.1)*

### Phase 2 — Operational readiness (Weeks 5–7)
14. Test suite: unit (maskOps/colorEngine/colorSuggest/commitImport), integration (import round-trip, cleanup), e2e (create→upload→mask→paint→export→refresh). *(P0 gap)*
15. Lint + typecheck + CI (GitHub Actions: test, build, docker build). 
16. Production frontend container (`vite build` + static server/nginx), remove dev-server posture.
17. Compose/prod env wiring for AI keys + access key; remove hardcoded creds; add rate limit on `/clean`.
18. Migration versioning (schema table + ordered scripts); MySQL + volume backup/restore runbook; request-ID + error tracking.

### Phase 3 — Scale & product (Weeks 8–12)
19. Pagination for `listProjects`; clamp/validate `pageSize`; server-side hex-distance search.
20. RBAC (Rep/Manager/Admin) per spec §10 with server-side enforcement + project ownership fields.
21. Reports MVP (catalog usage, funnel, export activity) — unblocks the Manager persona.
22. PDF export with dealer branding (worker-based render pipeline).
23. AI surface segmentation (drop-in proxy returning a mask → existing layer pipeline), per README's plan.

---

## 16. Appendix — Key Evidence Index (file:line)

| Finding | Location |
|---|---|
| Import transaction bug (pool vs conn) | `backend/src/services/excelImport.service.js:55-98` (mutations at 71/75/78; conn used only for import_log at 83-87) |
| `/files/*` unauthenticated | `backend/src/app.js:50-56` (outside `/api` guard at `:37`) |
| Access key fails open | `backend/src/middleware/accessKey.middleware.js` |
| Live HF key / provider config | `backend/.env`; `backend/.env.example:30-54` |
| Compose lacks access key + AI env | `docker-compose.yml:18-44` |
| Frontend container = dev server | `frontend/Dockerfile` (`npm run dev -- --host`) |
| Export resolution ceiling | `frontend/src/features/visualizer/canvas/useImageElement.js` (1600) → `ExportPanel.jsx:33-71,135-147` |
| Side-by-side JPG mixes resolutions | `ExportPanel.jsx:135-147` |
| Mask file accumulation | `layers.controller.js:66-67`; undo rationale `useHistoryCommand.js:99-106` |
| Re-import of soft-deleted colors | `paints.model.js:72-78` + `excelImport.service.js` `create` path |
| Inert `updatedAt` checks | `projects.model.js:57-71`; `layers.model.js:53-74`; no call site passes it |
| `listProjects` no pagination | `projects.model.js:27-45` |
| Unclamped pageSize | `paints.controller.js` (listPaints) → `paints.model.js` `LIMIT ? OFFSET ?` |
| Catalog export link 401 | `CatalogPage.jsx:97` + `api.js:49` + `app.js:37` |
| Dead swatch rail | `tokens.css:1-7`; `Sidebar.jsx` (no props); `App.jsx`; `VisualizerWorkspace.jsx:101` |
| Dead store fields | `visualizerStore.js:31,40,57,58` (`compareMode`, `inProgressMaskCanvas`) |
| No status-change UI | `useProjects.js` (updateProject unused) |
| Asset delete cleans masks, not concept/export files | `assets.controller.js:90-119` vs `concepts/exports` project paths |
| Schema FKs | `schema.sql:95,116-117,129,141,155` |
| Reconcile script | `backend/src/scripts/reconcileUploads.js` (depth ≤2, dry-run) |
| Migration script | `backend/src/scripts/runSchema.js` |

*End of report.*
