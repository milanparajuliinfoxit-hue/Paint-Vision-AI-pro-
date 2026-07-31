# Paint Dealer Visualizer — File-by-File Audit

Audit date: 2026-08-01 · Repo root: `C:\Users\Lenovo\Downloads\paint-visualizer (1)\paint-visualizer`

## 1. Executive summary

This is a **working scaffold**, not a finished product. The core loops are real and
verified:

- **Catalog CRUD** — fully working (backend + UI)
- **Excel import / export** — fully working (preview → diff → commit, with duplicate strategy)
- **Client-side recolor** — fully working (LAB blend on `<canvas>`, manual brush)
- **Rule-based color suggestions** — fully working client-side
- **Save result back to server** — fully working
- **AI cleanup (remove objects)** — **wired but inert**: requires a real `CLIPDROP_API_KEY`
- **Automatic surface segmentation** — **not implemented** (manual brush only)
- **Client / project tracking UI** — **backend exists, no UI flow**

One real correctness bug found (Excel import transaction does not actually wrap the writes —
see §5.4). No tests exist anywhere.

---

## 2. Current run state

| Component | Status | How |
|---|---|---|
| MySQL | Running (local **MySQL 9.6**, service `MySQL96`) | Database `paint_visualizer_pro`, user `paint_app` / `change-me` |
| Schema migration | Applied | `npm run migrate` (5 tables created) |
| Backend deps | Installed | `backend/node_modules` |
| Backend server | Ready — start with `cd backend && npm run dev` | port 4000 |
| Frontend deps | Already present | `frontend/node_modules` |
| Frontend server | Ready — start with `cd frontend && npm run dev` | port 5173 |
| Docker | **Not available** on this machine | `docker` not on PATH |

### Setup actions taken during audit
- Created DB user `paint_app`@`localhost` / `change-me` and new DB `paint_visualizer_pro`
  (a pre-existing `paint_visualizer` DB with an unrelated Prisma schema was deliberately **not** touched).
- Created `backend/.env` and `frontend/.env` from the examples (shared `API_ACCESS_KEY=pv-local-dev-key-2026`).
- Patched `backend/src/scripts/runSchema.js` so `npm run migrate` substitutes `DB_NAME` from
  `.env` — the schema file itself hardcodes `paint_visualizer`.
- Installed backend deps (`npm install`).

---

## 3. High-level architecture (as implemented)

```
frontend (React/Vite)  ──HTTP──▶  backend (Express)  ──HTTP──▶  hosted AI API (Clipdrop cleanup)
        │                              │
   <canvas> recolor              MySQL (catalog, jobs)
   (client-side only)            + local /uploads folder storage
```

- All pixel processing (recolor) runs in the browser on `<canvas>` — `frontend/src/lib/colorEngine.js`.
- AI *suggestions* are rule-based (color theory), client-side — `frontend/src/lib/colorSuggest.js`.
- The server does **no image processing**. It stores files and proxies one hosted-AI call
  (cleanup/inpainting) through `backend/src/services/aiProxy.service.js`.
- No user auth by design (single dealer, internal tool) — only a shared `x-api-key` guard.

---

## 4. Backend — file by file

### `src/server.js` — ✅ working
Bare entry point. `app.listen(4000)`. Nothing else.

### `src/app.js` — ✅ working
Express assembly:
- `helmet()`, CORS (origin from `CORS_ORIGIN`), `morgan`, `express.json({ limit: '2mb' })`
- Rate limits on `/api/visualizer/upload` and `/api/catalog/import`
- `requireAccessKey` applied to `/api/*`
- `GET /health` → `{ status: 'ok' }`
- Mounts paints / import / visualizer / projects routers
- `GET /files/*` serves stored images via `storage.service` (path-traversal guarded)
- Global error handler

> Note: `/files/*` is **not** behind the access-key middleware (it sits outside `/api`).
> Fine for internal tooling; intentional or not, document it if this ever goes public.

### `src/config/db.js` — ✅ working
`mysql2/promise` connection pool built from env vars. Nothing to change.

### `src/middleware/accessKey.middleware.js` — ✅ working (dev-mode pass-through)
Checks `x-api-key` header against `API_ACCESS_KEY`. **If the key is unset or equals
`change-me-long-random-string`, it lets requests through** — so misconfiguration fails open.

### `src/middleware/errorHandler.middleware.js` — ✅ working
Logs and returns JSON error. No status-code mapping (always 500 unless err.status set).

### `src/routes/paints.routes.js` — ✅ working
`GET /` (list), `GET /:id`, `POST /`, `PUT /:id`, `DELETE /:id` (soft delete).

### `src/controllers/paints.controller.js` — ✅ working
- Zod-validates body; 400 with issues on failure
- 409 on duplicate `color_code`
- 404s, soft delete on DELETE (returns 204)

### `src/services/paints.model.js` — ✅ working
- `list()`: search (name/code `LIKE`), product-line filter, pagination, excludes `is_deleted`
- `create/update/softDelete/getById/findByColorCode` (matches on `color_code`)
- `hex_value` is a **generated column** in the schema, not computed here

### `src/services/paints.validation.js` — ✅ working
Zod `paintSchema` (name, code, RGB 0–255, 7 boolean product-line flags) +
`EXCEL_COLUMN_MAP` for Excel header mapping.

### `src/routes/importExport.routes.js` — ✅ working
`POST /preview` (multipart, ≤10 MB), `POST /commit` (JSON), `GET /export`.

### `src/controllers/importExport.controller.js` — ✅ working
Thin pass-through to service. Export streams the whole catalog (pageSize 100000) as `.xlsx`.

### `src/services/excelImport.service.js` — ⚠️ mostly working, **one real bug**
- `previewImport()`: reads first sheet, maps headers, validates each row, flags
  `create`/`update` by existing `color_code`, returns a diff report. ✅
- `commitImport()`: iterates valid rows and applies duplicate strategy. **Bug (see §5.4)** —
  writes call `paintsModel.*` which use the **pool**, not the transaction `connection`, so
  `beginTransaction/commit` never actually wraps the inserts.
- Writes an `import_log` row.
- `exportToBuffer()`: round-trips columns back to Excel with the same header names. ✅
- `mapRow()`: skips the ambiguous `id` column; treats `s_id` as the traceable source id
  (**assumption to confirm against the real file**, same callout as the README).

### `src/routes/visualizer.routes.js` — ✅ working
`POST /upload` (≤ `MAX_UPLOAD_MB`), `GET /jobs/:jobId`,
`POST /jobs/:jobId/cleanup` (optional mask), `POST|GET /jobs/:jobId/results`.

### `src/controllers/visualizer.controller.js` — ✅ working (with minor inconsistency)
- `uploadImage()`: creates a UUID job row, saves `original.jpg` under `uploads/<jobId>/`,
  then updates the row. Note it reaches into the DB directly via an inline
  `require('../config/db')` instead of going through `projects.model` — works, but breaks the layering.
- `requestCleanup()`: marks `cleaning` → calls `aiProxy.callCleanup` → stores `cleaned.jpg` →
  marks `cleaned`; on error marks `failed`. ✅ (will fail until a real AI key is set)
- `saveResult()` / `listResults()`: store/return client-exported PNGs. ✅

### `src/services/aiProxy.service.js` — ⚠️ wired, **inert without a real key**
- Provider switch on `AI_PROVIDER` (only `clipdrop` implemented).
- Posts image (+ optional mask) to `CLIPDROP_CLEANUP_URL` with `x-api-key`.
- Throws a clear error if the key is unset or still `replace-with-*`.
- Uses global `fetch`/`FormData`/`Blob` (requires Node ≥ 18).

### `src/services/storage.service.js` — ✅ working
Local-disk storage: `saveBuffer`, `readFile`, `exists`, `deleteFile`, plus a path-traversal
guard in `absolutePath()`. This is the single swap point for S3 later.

### `src/services/projects.model.js` — ✅ working
`projects` (create/list/get) and `visualization_jobs` (create/get/updateStatus) and
`job_results` (save/list) CRUD. Used by routes and visualizer controller.

### `src/scripts/runSchema.js` — ✅ working (patched)
Applies `schema.sql`. **Patched this session**: substitutes the hardcoded `paint_visualizer`
database name with `DB_NAME` from `.env`, so it creates `paint_visualizer_pro`.

### `src/sql/schema.sql` — ✅ working
5 tables: `paints` (+ generated `hex_value` column), `import_log`, `projects`,
`visualization_jobs` (UUID PK, status enum), `job_results`. FK constraints included.
Still hardcodes the DB name `paint_visualizer` (handled at runtime by the script above).

---

## 5. Frontend — file by file

### `src/main.jsx` — ✅ working
React 18 + `BrowserRouter` + `tokens.css`. Loads Google fonts in `index.html`.

### `src/App.jsx` — ✅ working
Layout: `Sidebar` + routed `main`. Routes `/catalog` and `/visualizer`, `/` redirects to
`/catalog`. Holds `activeColor` state (drives the sidebar swatch rail).

### `src/lib/api.js` — ✅ working
`fetch` wrapper injecting `x-api-key` and JSON/form headers. Exposes three API clients:
`catalog` (list/get/create/update/remove, import preview/commit, export URL),
`visualizer` (upload/getJob/requestCleanup/saveResult/listResults/fileUrl),
`projects` (list/create).

### `src/lib/colorEngine.js` — ✅ working (core feature)
sRGB↔linear↔XYZ↔CIELAB conversions + `applyPaintColor(imageData, maskData, targetRgb, strength)`.
Preserves each pixel's **lightness** while pulling a/b toward the target — photorealistic
recolor. Also `paintCanvasRegion()` canvas convenience wrapper.

### `src/lib/colorSuggest.js` — ✅ working (rule-based, no ML)
`extractContextColors()` samples a sparse grid **outside** the mask (alpha ≤ 0.2),
quantizes to color buckets, returns the dominant context colors.
`suggestColors()` builds complementary/analogous/monochrome hue targets from the dominant
context color and ranks the catalog by LAB distance. De-dupes by `color_code`.

### `src/pages/CatalogPage.jsx` — ✅ working
- Table with swatch, code, name, hex, product-line tags
- Search + product-line filter + pagination (20/page)
- Add/Edit modal (`PaintEditor`) with RGB inputs + product-line checkboxes
- Delete with `confirm()`
- Import modal trigger + Export link

### `src/pages/VisualizerPage.jsx` — ✅ working (with rough edges)
Step flow: Upload → Cleanup → Select surface → Apply color → Save.
- Upload: posts file, displays it immediately client-side. ✅
- Cleanup: calls proxy; **fails until AI key set** (gracefully lets user skip). ✅/⚠️
- Suggestions: calls `suggestColors` against the catalog. ⚠️ **Fragile**: reaches into the
  DOM (`document.querySelector('.viz-canvas canvas')`) and builds an **empty mask**, so the
  "context" sampling includes the target surface too (i.e. it isn't sampling truly
  un-painted context). Works, but not as designed.
- Apply color → `canvasRef.current.applyColor(rgb, 0.85)`. ✅
- Save → exports PNG and POSTs it. ✅
- **No client-project flow**: `projects` API is never called here; upload sends no `projectId`.

### `src/components/ImageCanvas.jsx` — ✅ working (core feature)
Displays the image (downscaled to max 1600px client-side), keeps separate base/mask canvases,
implements the brush tool (mouse events → mask circles), exposes
`clearMask / applyColor / setBaseImage / exportPng / getDims` via `useImperativeHandle`.
`applyColor` re-blends from the untouched base so repeated recolor doesn't compound. ✅
Mouse-only (no touch support).

### `src/components/ImportModal.jsx` — ✅ working
Preview → summary (new/update/error) → duplicate strategy → commit. Matches the backend
preview/commit contract.

### `src/components/Sidebar.jsx` — ✅ working
Nav + signature "paint stick" swatch rail that reflects the active color.

### `src/components/ColorSwatch.jsx` — ✅ working
Tiny hex swatch button with selected ring.

### `src/components/StepIndicator.jsx` — ✅ working
4-step indicator (Upload / Clean up / Select surface / Apply color).

### `src/styles/tokens.css` — ✅ working
Design tokens ("mixing room" theme): palette, fonts, radii, shadows, a11y focus styles,
`prefers-reduced-motion` support.

### `vite.config.js`, `index.html` — ✅ working
Vite dev server on 5173; fonts preconnected.

---

## 6. Infra / config

| File | Status | Notes |
|---|---|---|
| `docker-compose.yml` | ⚠️ Untested here (no Docker) | Spins up MySQL + backend + frontend; uses `paint_visualizer` DB |
| `backend/Dockerfile` | OK | node:20-alpine, `--omit=dev` |
| `frontend/Dockerfile` | OK | dev-mode (`vite --host`) |
| `backend/.env.example` | OK | Documented, matches actual use |
| `frontend/.env.example` | OK | Matches actual use |
| `.gitignore` (root) | — | **Repo is not git-initialized** |

---

## 7. Implemented vs not implemented

### ✅ Implemented and working
- Catalog list / search / filter / pagination
- Catalog create / update / soft-delete
- Excel import: preview/diff, duplicate strategy, commit, import_log
- Excel export
- Image upload → job creation (UUID, status lifecycle)
- Local folder storage service
- Client-side manual brush surface selection
- Client-side LAB recolor engine
- Client-side rule-based color suggestions
- Save final look back to server (`job_results`)
- Dealer UI (catalog + visualizer) styled to design tokens
- Backend API key middleware + rate limiting + helmet

### ⚠️ Wired but blocked / needs config
- **AI cleanup proxy** — code complete; requires a real `CLIPDROP_API_KEY` in `backend/.env`
  (or swap `AI_PROVIDER` + provider block in `aiProxy.service.js`).

### ❌ Not implemented / stubbed
- **Automatic surface segmentation** (wall/roof/trim detection) — manual brush only
- **Client / project workflow in the UI** — `projects` API exists backend-side but the
  frontend never creates/assigns a project; uploads always pass no `projectId`
- **AI suggestions from true "un-painted context"** — sampling uses an empty mask (whole image)
- **Touch / pointer support** in the brush canvas
- **Auth / users / roles** — intentionally out of scope (single dealer)
- **Tests** — none (unit, integration, or e2e)
- **Lint / typecheck / CI** — none configured
- **Docker run on this machine** — Docker not installed

---

## 8. Issues & risks to fix before this is "real"

1. **P0 — Excel import transaction doesn't wrap writes** (`excelImport.service.js:64-88`).
   `paintsModel.create/update` use the shared pool (auto-commit), so `beginTransaction` /
   `commit` / `rollback` have no effect — a partial import leaves the DB half-written.
   Fix: move the SQL for create/update into this service against the `conn`, or pass `conn`
   into the model methods.
2. **P1 — AI cleanup silently useless until key set.** The UI lets the user continue with the
   original photo (good), but there's no indication in the UI of *why* cleanup failed.
3. **P1 — `updateJobStatus` can't clear fields** (`projects.model.js:36-41`): `cleaned_path`
   uses `COALESCE(?, cleaned_path)`, so passing null keeps the old value — fine for normal
   flow, but you can't ever reset a field.
4. **P1 — Visualizer page DOM scraping** (`VisualizerPage.jsx:69`): `document.querySelector
   ('.viz-canvas canvas')` couples the page to ImageCanvas internals. Prefer exposing the
   image pixels through the ref (like the other helpers).
5. **P2 — Access key fails open** (`accessKey.middleware.js`): if `API_ACCESS_KEY` is unset or
   the placeholder, requests pass. Safe for dev, dangerous if deployed by mistake.
6. **P2 — `/files/*` is unauthenticated** (`app.js:41`): any stored upload is publicly
   readable. Fine internally; add auth/redirects if exposed.
7. **P2 — Layering inconsistency** (`visualizer.controller.js:19`): inline `require('../config/db')`
   bypasses `projects.model`.
8. **P3 — Orphaned upload folders** already exist in `backend/uploads/uploads/` (two job
   folders) with no corresponding rows in the current `paint_visualizer_pro` DB — leftover
   from prior runs against the old DB.
9. **P3 — No server-side image dimension cap**: upload is size-limited only; the README's
   "4000px" guidance is a note in the API response, not enforced.
10. **P3 — `id` vs `s_id` Excel ambiguity** is unresolved by design (`paints.validation.js:23-27`).
    Confirm against the actual source file.

---

## 9. Suggested next steps

1. Set `CLIPDROP_API_KEY` in `backend/.env` and test cleanup end-to-end.
2. Fix the import transaction bug (P0) before any real catalog import.
3. Wire a "create project / assign client" step into the Visualizer upload flow
   (backend + `projects` API are already there).
4. If desired, add automatic segmentation as a second proxied AI call
   (drop-in: return a mask, feed it to the existing brush/mask pipeline).
5. Add at least smoke tests for the catalog CRUD and import preview/commit.
6. Consider making `/files/*` authenticated and setting a real `API_ACCESS_KEY`.
