# Paint Dealer Visualizer — v2

A project-centric AI visualization platform for paint dealers: a persistent, layer-based
photo workspace where a dealer masks surfaces, tries catalog colors in real time, and
exports a client-ready comparison — nothing is lost on refresh.

This supersedes the v1 scaffold (single-page 4-step wizard, no persistence). See `v2.md`
for the full product/engineering spec this implements.

## Architecture

```
frontend (React/Vite, Konva canvas)  ──HTTP──▶  backend (Express)  ──HTTP──▶  hosted AI API (cleanup)
        │                                            │
   layer compositing,                          MySQL (catalog, projects,
   client-side LAB recolor                     assets, layers, history,
   (no server round trip)                       concepts, exports)
                                                   + local /uploads
```

- **Client does the image work**, same as v1: applying a catalog color to a masked
  surface runs in the browser on `<canvas>` using a LAB-color-space blend
  (`frontend/src/shared/lib/colorEngine.js`) that preserves the photo's shading/texture.
  Each `Layer` composites independently (Konva), so changing one layer's color
  re-renders only that layer, not the whole canvas.
- **Server = storage + a thin AI proxy**, unchanged in spirit: plain CRUD (catalog,
  projects, assets, layers, history, concepts, exports) backed by MySQL plus local-disk
  file storage. The only AI call is `POST /api/assets/:id/clean`, forwarded to a hosted
  provider (Clipdrop/Hugging Face) — no image processing happens in this process.
- **No auth/RBAC** — single-editor, no login, matching v1's model (explicit product
  decision for this phase; see `v2.md` §10 for the deferred role model).

## Data model

`projects` → `assets` (original + AI-cleaned photo) → `layers` (masked, re-colorable
surface regions) — plus `history_entries` (undo/redo log), `concepts` (saved "looks"),
and `export_jobs`. Full schema: `backend/src/sql/schema.sql`.

## What's implemented

| Area | Status |
|---|---|
| Catalog CRUD, Excel import/export | ✅ working (unchanged from v1) |
| Project-centric IA (Dashboard / Projects / `/projects/:id/visualize`) | ✅ working |
| Konva canvas: layers-with-masks, live per-layer recolor | ✅ working |
| Selection tools: rect, lasso, polygon, magic wand, brush (mask-edit + direct-paint), bucket fill, eyedropper | ✅ working |
| Undo/redo (command pattern) + scrubbable History tab | ✅ working |
| Autosave (optimistic + debounced) + IndexedDB draft cache + conflict toast | ✅ working |
| Paint Catalog cards, favorites/recently-used (localStorage), hex-proximity search, hover-preview | ✅ working |
| Layer-aware AI color suggestions (samples outside the active layer's actual mask) | ✅ working |
| Comparison modes (side-by-side/slider/split/fade) + PNG/side-by-side-JPG export | ✅ working |
| Keyboard shortcuts, ARIA live save/toast status, responsive breakpoints (full 3-pane ≥1280px, collapsed 768–1279px, read-only <768px) | ✅ working |
| AI cleanup proxy | ⚠️ wired, needs a real provider API key — see `backend/.env.example` |

### Explicitly deferred (not stubbed, not silently faked)
- **RBAC/roles** — per product decision for this phase.
- **Reports** — depends on cross-rep aggregation that needs roles to be meaningful.
- **AI Surface Selection (auto segmentation)** — no segmentation vendor wired yet; manual
  selection tools cover surface masking today.
- **PDF export with dealer branding** — needs a render pipeline beyond client `<canvas>`;
  PNG and side-by-side JPG export work today, and the export endpoint returns a clear
  501 (not a silent downgrade) if PDF is requested.

## Running it locally

```bash
# 1. Start MySQL (or use docker-compose for everything)
docker compose up -d mysql

# 2. Backend
cd backend
cp .env.example .env      # fill in DB + AI API key
npm install
npm run migrate           # applies schema.sql (safe to re-run — additive/idempotent)
npm run dev                # http://localhost:4000

# 3. Frontend
cd frontend
cp .env.example .env
npm install
npm run dev                # http://localhost:5173
```

Or everything at once: `docker compose up --build` from the project root.

## Next steps

1. Plug in a real Clipdrop (or alternate) API key and test the cleanup step end-to-end.
2. Decide on an AI surface-segmentation vendor if automatic wall/roof/trim detection is
   wanted (drop-in: same proxy pattern as cleanup, returns a mask consumed by the
   existing layer pipeline).
3. If/when auth is needed, `createdBy`-style fields and per-project ownership can be
   added without a data migration — nothing here assumes a single global user.
