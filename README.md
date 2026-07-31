# Paint Dealer Visualizer — v1 Scaffold

Monolithic, single-dealer, no-auth app with two modules: **Color Catalog Management** and **AI Paint Visualizer**.

## Architecture (as implemented)

- **Client does the image work.** All pixel-level processing — applying a
  catalog color to a selected surface — runs in the browser on `<canvas>`
  using a LAB-color-space blend that preserves the original photo's shading
  and texture (`frontend/src/lib/colorEngine.js`). Nothing in this pipeline
  touches the server.
- **AI color suggestions are also client-side** — a rule-based engine
  (`frontend/src/lib/colorSuggest.js`) samples the untouched parts of the
  photo and matches catalog colors using color theory (complementary/analogous
  hues), not a black-box model call.
- **Server = storage + a thin AI proxy.** The backend is a plain CRUD API
  (catalog, projects, job metadata) backed by MySQL, plus local-disk file
  storage. The one place it talks to AI is `POST /api/visualizer/jobs/:id/cleanup`,
  which forwards the image to a **hosted AI API (Path B)** and stores the
  result — it does not run any model itself. This exists only because a
  vendor API key can't safely live in the browser bundle.

```
frontend (React/Vite)  ──HTTP──▶  backend (Express)  ──HTTP──▶  hosted AI API (cleanup/inpainting)
        │                              │
   <canvas> recolor              MySQL (catalog, jobs)
   (client-side, no                 + local /data/uploads
    server round trip)
```

## What's implemented in this scaffold

| Area | Status |
|---|---|
| Catalog CRUD (list/search/filter/create/update/soft-delete) | ✅ working |
| Excel import — preview/diff, duplicate strategy, commit | ✅ working |
| Excel export | ✅ working |
| MySQL schema (paints, projects, visualization_jobs, job_results) | ✅ working |
| Local folder storage service (swappable for S3 later) | ✅ working |
| Image upload → job creation | ✅ working |
| AI cleanup proxy endpoint | ✅ wired, **needs a real API key** — see below |
| Client-side surface selection | ✅ working (manual brush tool, v1) |
| Client-side recolor engine (LAB blend) | ✅ working |
| Client-side AI color suggestions (rule-based) | ✅ working, tune-able |
| Save final look back to server | ✅ working |
| Dealer UI (catalog + visualizer pages) | ✅ working, styled per design tokens |

## What's intentionally stubbed / needs a decision from you

1. **Hosted AI vendor.** AI calls go through a **provider-agnostic layer**
   (`backend/src/services/aiProxy.service.js` dispatcher → `backend/src/services/providers/`).
   Two providers ship today:
   - **Clipdrop** (default) — `AI_PROVIDER=clipdrop`, activate with `CLIPDROP_API_KEY` in `backend/.env`.
   - **Hugging Face Inference Providers** — `AI_PROVIDER=huggingface` with `HF_API_KEY`, `HF_MODEL`,
     `HF_API_URL` (see `.env.example`). The legacy `api-inference.huggingface.co` endpoint is
     decommissioned; calls go to `https://router.huggingface.co/<provider>/<provider-model-id>`
     and image models are **billed to the HF account** (HTTP 402 when credits are depleted).
     Request format (json/binary/multipart) and field names are configurable because
     provider payloads differ — e.g. fal-ai edit models want
     `{"prompt": …, "image_urls": ["data:image/png;base64,…"]}` (`HF_JSON_SHAPE=image_urls`).
   Adding another provider (Replicate, Fal.ai, custom FastAPI…) is just a new
   `providers/<name>.js` + a case in the dispatcher — routes/controllers/frontend stay untouched.
   Shared HTTP behavior (30s timeout, retry on 429/503/504, structured logging) lives in
   `providers/httpClient.js`.
2. **Automatic surface segmentation.** v1 uses a manual brush to select the
   surface to paint (simple, reliable, ships today). Automatic wall/roof/trim
   detection (so the user doesn't have to brush at all) is a real feature to
   add next — likely another hosted-API call (e.g. a segmentation endpoint)
   proxied the same way as cleanup.
3. **Client/job tracking.** `projects` table exists but the UI doesn't yet
   surface a "create project for this client" flow — wire it into the upload
   step whenever you're ready.

## Running it locally

```bash
# 1. Start MySQL (or use docker-compose for everything)
docker compose up -d mysql

# 2. Backend
cd backend
cp .env.example .env      # fill in DB + AI API key
npm install
npm run migrate           # applies schema.sql
npm run dev                # http://localhost:4000

# 3. Frontend
cd frontend
cp .env.example .env
npm install
npm run dev                # http://localhost:5173
```

Or everything at once: `docker compose up --build` from the project root
(after filling in real env values in `docker-compose.yml` / a `.env` it reads).

## Next steps I'd suggest

1. Plug in a real Clipdrop (or alternate) API key and test the cleanup step
   end-to-end with an actual client photo.
2. Try the Excel import against your real file to confirm the column mapping
   (`backend/src/services/paints.validation.js`) matches exactly — the `id`
   vs `s_id` ambiguity from your sample is called out there.
3. Decide on automatic surface segmentation (item 2 above) once the manual
   brush flow feels right in practice — it's a drop-in addition, not a rewrite.
