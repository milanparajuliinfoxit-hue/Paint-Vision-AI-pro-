# AI Schemes Implementation Audit & Memory Optimization Report

**Scope:** Complete end-to-end trace of the AI Schemes feature (house-understanding → catalog-scored paint schemes → rendered previews → apply/save-as-concept). Analysis only — no code changed.
**Working resolution** used throughout: `useImageElement` caps images at 1600px (`frontend/src/features/visualizer/canvas/useImageElement.js:3`). A 4:3 photo renders at **1600×1200 = 1.92M px = 7.68 MB RGBA** per ImageData/canvas. All byte figures below use this.

---

## 1. Executive Summary

AI Schemes is a **two-tier architecture**:

- **Server** (`backend/src/services/ai/*`): the mock/heuristic house-understanding provider segments the photo into surfaces with alpha masks; the `catalog` provider scores **template color schemes against the full paint table** and persists them. The server never touches pixels after analysis — it only stores masks and scheme JSON.
- **Browser**: the renderer (`LayerNode` → `applyPaintColor`, a full-image per-pixel LAB recolor pass) is the single paint engine, used three times independently: live canvas layers, scheme previews, and export compositing.

The excessive CPU/RAM is caused by **repeated full-resolution work on the main thread**, not by a single catastrophic allocation:

1. **`previews[scheme.id].toDataURL('image/png')` is called during every render** of `RecommendationsTab` (`RecommendationsTab.jsx:167`). Each render re-encodes every full-res preview canvas (≈7.7 MB backing store each) into a base64 PNG string and the browser re-decodes it into `<img>`. This is the #1 avoidable hotspot and runs on every parent/state re-render.
2. **Scheme previews re-run the entire LAB recolor pipeline** (6–10 schemes × ~5 surfaces = up to 30 full-image pixel passes) on every generation and on every dependency change (`RecommendationsTab.jsx:66-79`), concurrently via `Promise.all` — peak main-thread + heap pressure is the product of all schemes, not one.
3. **The same surface mask PNG is fetched/decoded once per scheme** (a mask used by all 6 schemes is decoded 6×), because there is no mask cache in the preview path (`renderSchemePreview.js:31`).
4. **`renderSchemePreview` does not actually composite.** Each `ctx.putImageData(result)` overwrites the entire canvas (`renderSchemePreview.js:37`), so only the last surface survives; everything else becomes transparent. The rendered preview is not the scheme.
5. **Every applied/exported layer repeats the identical full-res LAB pass** (`LayerNode.jsx:29-53`, `ExportPanel.jsx:44-71`) — correct per-layer caches exist in `LayerNode`, but nothing is shared with preview generation.
6. **Server**: `generateRecommendations`/`listRecommendations` load the entire paint table (`pageSize: 100000`, `paintRecommendation.service.js:35,90`) and `pick()` recomputes `rgbToLab` per paint per role per template (`catalogRecommendationProvider.js:211-221`) with no per-batch precompute — O(templates × roles × paints) LAB conversions on the Node event loop.

No genuine memory *leak* was found (no `createObjectURL` in the codebase, all listeners/timers cleaned up), but **large canvases are retained in React state for the whole tab session** and the `toDataURL` churn creates heavy GC pressure. The dominant cost is *duplicated, un-memoized, full-resolution work*.

---

## 2. Complete Architecture Diagram

```
                          ┌──────────────────────────────────────────────────────────────┐
                          │                         BROWSER                              │
                          │                                                              │
┌──────────────┐  props   ┌─────────────────────┐      ┌───────────────────────────────┐  │
│ Visualizer-  │─────────▶│   SidePanel         │─────▶│  RecommendationsTab (AI       │  │
│ Workspace    │          │  (not memoized)     │      │  Schemes)                     │  │
│ (store subs) │          └─────────────────────┘      │  • previews state (canvases)  │  │
└──────┬───────┘                                        │  • toDataURL per render  ◀─── │  │
       │                                               └──────────────┬────────────────┘  │
       │ baseImage, baseImageData, width,height                         │ renderSchemePreview│
       │                                                               ▼                    │
       │        ┌───────────────────────────────────────────────────────────────────┐     │
       │        │   renderSchemePreview.js  ◀── colorEngine.applyPaintColor         │     │
       │        │   (per scheme: canvas + per-surface mask decode + LAB pass)       │     │
       │        └───────────────────────────────────────────────────────────────────┘     │
       │                                                                                    │
       │        ┌───────────────────────────── CanvasStage (Konva) ─────────────────────┐  │
       │        │  Layer (base KonvaImage) + LayerNode per layer  →  useImageElement     │  │
       │        │  LayerNode → applyPaintColor (raf-coalesced, bitmap cached)            │  │
       │        │  Tool overlay: surface-aware brush → maskOps.surfaceAwareBrushStroke   │  │
       │        └────────────────────────────────────────────────────────────────────────┘ │
       │                                                                                    │
       │        useSurfaceConstraintAlpha / useSurfaceAlphaGrids ──▶ loadAlphaGrid        │
       │        useApplySurface ──▶ surfaceMaskToPngBlob ──▶ POST /layers (multipart)     │
       └───────────────┴───────────────────────┴───────────────────────┴──────────────────┘
                        │                       │                       │
              TanStack Query cache          fetch (api.js)          Zustand (ephemeral)
              staleTime 10s                 LONG_TIMEOUT 60s
────────────────────────┼───────────────────┼────────────────────────┼───────────────────────
                        ▼                   ▼                         ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                       HTTP /api/assets/:assetId/ai/*  (+ /files/*  for masks/photos)      │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│  ai.controller.js ──▶ paintRecommendation.service.js ──▶ aiRegistry ──▶ providers/        │
│     generateRecommendations     │            ▲                            catalog-        │
│     listRecommendations         │            └── catalogRecommendationProvider           │
│     analyzeAsset                ▼                                                    │   │
│        houseUnderstanding.service.js ──▶ aiRegistry ──▶ mockProvider (Jimp)        │   │
│        saveMask: Jimp PNG per surface ──▶ storage.saveBuffer                      │   │
│                                                                                     │   │
│  DB: paints / paint_recommendations / ai_jobs / ai_surfaces / layers / concepts     │   │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Execution Flow Diagram (click **Generate AI Schemes** → schemes on screen)

```
User clicks "Generate N schemes"   (RecommendationsTab.jsx:136)
  └─▶ runGenerate()                        (RecommendationsTab.jsx:81)
        └─▶ generate.mutateAsync()         (useRecommendations.js:19)
              └─▶ ai.generateRecommendations → POST /api/assets/:id/ai/recommendations  (api.js:136, 60s timeout)
                    └─▶ ai.controller.generateRecommendations     (ai.controller.js:29)
                          └─▶ paintRecommendation.service.generateRecommendations  (service.js:15)
                                ├─▶ assetsModel.getAsset
                                ├─▶ aiJobsModel.getLatestAnalysis       (409 if none)
                                ├─▶ paintsModel.list(pageSize 100000)   ← full catalog to memory
                                ├─▶ aiRegistry.run('paint-recommendation')
                                │     └─▶ catalogRecommendationProvider.run   (provider.js:134)
                                │           ├─▶ filterPool(paints, productLines)
                                │           ├─▶ TEMPLATES.slice(0, count).map(buildScheme)  ← per template
                                │           │     └─▶ buildScheme → per role → pick() → O(P) LAB scan
                                │           └─▶ returns { schemes } (paintIds only)
                                ├─▶ recommendationsModel.clearForAsset   (delete old batch)
                                ├─▶ per scheme: createScheme (INSERT + SELECT, N+1)
                                └─▶ resolveScheme → embeds full paint objects → JSON response
        └─▶ onSuccess: invalidateQueries(['ai-recommendations', assetId])   (useRecommendations.js:20)
              └─▶ useRecommendations refetch → GET /ai/recommendations
                    └─▶ paintRecommendation.service.listRecommendations  ← full catalog reloaded + Map rebuild
                          └─▶ new `schemes` array (new identity)
                                └─▶ RecommendationsTab re-render + preview effect re-runs  (Tab.jsx:58-79)
                                      └─▶ Promise.all(schemes.map(renderSchemePreview))   ← ALL at once
                                            per scheme:
                                              create canvas w×h  (7.68MB)
                                              putImageData(baseImageData)
                                              per surface:
                                                loadMaskImageData(mask_url)  → fetch+decode+draw+getImageData (7.68MB)
                                                applyPaintColor(...)          → new ImageData copy + per-pixel LAB (7.68MB)
                                                putImageData(result)          → overwrite (see §10 bug)
                                              return {id, canvas}
                                      └─▶ setPreviews(next) → re-render
                                            └─▶ <img src={preview.toDataURL('image/png')}>   ← re-encode EVERY render
```

```
Apply (per scheme card):
  apply(scheme)                        (RecommendationsTab.jsx:90)
    └─▶ applyScheme(scheme, surfacesByClass)    (useApplySurface.js:50)
          └─▶ per surface (sequential):
                ├─▶ surfaceMaskToPngBlob(mask_url)  (maskImage.js:40)  fetch+decode+draw+toBlob PNG re-encode (full res)
                └─▶ createLayer.mutateAsync({maskBlob}) → POST /layers  (api.js:109)
                      └─▶ layers.controller.createLayer  → upsertAiLayer  (idempotent, 201/200)
                            └─▶ layers.model.upsertAiLayer (ON DUPLICATE KEY UPDATE)
          └─▶ if layer._created → commitCreate → history append + undo stack
          └─▶ setActiveLayerId → store update → VisualizerWorkspace re-render → SidePanel → RecommendationsTab re-render → toDataURL×N

Save as concept:
  saveAsConcept(scheme)                (RecommendationsTab.jsx:101)
    └─▶ canvasToThumbnailBlob(preview) (renderSchemePreview.js:45)  → downscale to 256px + toBlob
    └─▶ saveConcept.mutateAsync → POST /concepts (multipart)
    └─▶ setSavedNames → re-render → toDataURL×N again
```

---

## 4. File Dependency Map

**Frontend** (feature = AI Schemes):

| File | Role in AI Schemes | Loaded |
|---|---|---|
| `panels/RecommendationsTab.jsx` | Entry point; owns preview canvases + toDataURL | Always mounted when section active |
| `hooks/useRecommendations.js` | Query + generate mutation | Tab |
| `hooks/useAiAnalysis.js` | analysis query, alpha grids/constraints | Workspace + tab |
| `hooks/useApplySurface.js` | surface/scheme → layers | Tab + AIAnalyzeTab + workspace |
| `lib/renderSchemePreview.js` | preview composer + thumbnail | Tab |
| `shared/lib/colorEngine.js` | `applyPaintColor` (LAB engine) | LayerNode, previews, Export, tools |
| `shared/lib/maskImage.js` | mask load/decode/grid/blob | previews, apply, workspace, tools |
| `canvas/LayerNode.jsx` | live renderer per layer | CanvasStage |
| `canvas/CanvasStage.jsx` | Konva stage | Workspace |
| `canvas/useImageElement.js` | base image decode/downscale | Workspace |
| `store/visualizerStore.js` | ephemeral state | everywhere |
| `shared/lib/api.js` | fetch wrappers | everywhere |
| `panels/ExportPanel.jsx` | third LAB consumer | Workspace |
| `tools/maskOps.js`, `tools/useToolInteraction.js` | brush/mask pipeline | Workspace |

**Backend**:

| File | Role |
|---|---|
| `routes/ai.routes.js`, `controllers/ai.controller.js` | endpoints |
| `services/ai/paintRecommendation.service.js` | orchestration + full-catalog resolve |
| `services/ai/providers/catalogRecommendationProvider.js` | rule-based scheme scoring (O(P) per role) |
| `services/ai/aiRegistry.service.js` | provider dispatch |
| `services/ai/houseUnderstanding.service.js` | analysis orchestration + mask persistence |
| `services/ai/providers/mockProvider.js` | heuristic segmentation (default) |
| `services/paintRecommendation.model.js`, `services/layers.model.js`, `services/paints.model.js` | SQL |
| `controllers/layers.controller.js` | idempotent ai-surface upsert |

---

## 5. Function Call Chain (hot paths)

**Preview generation** (the expensive one):
```
RecommendationsTab effect (Tab.jsx:58)
  → Promise.all
    → renderSchemePreview (renderSchemePreview.js:17)
      → loadMaskImageData (maskImage.js:19)  [fetch + new Image + canvas + getImageData]
        → loadImage (maskImage.js:7)
      → applyPaintColor (colorEngine.js:118)
        → rgbToLab (colorEngine.js:63)  [per masked pixel]
        → labToRgb (colorEngine.js:75)  [per masked pixel]
      → ctx.putImageData (renderSchemePreview.js:37)
  → setPreviews (Tab.jsx:75)
  → toDataURL per scheme (Tab.jsx:167) [every render]
```

**Live layer render** (main stage, raf-coalesced):
```
LayerNode effect (LayerNode.jsx:21)
  → requestAnimationFrame
  → mask canvas + getImageData (LayerNode.jsx:30-35)
  → applyPaintColor (colorEngine.js:118)
  → putImageData → setBitmap (LayerNode.jsx:48-52)
```

**Apply scheme**:
```
applyScheme (useApplySurface.js:50)
  → surfaceMaskToPngBlob (maskImage.js:40) per surface
  → createLayer.mutateAsync (useLayers.js:12) → layers API → upsertAiLayer (layers.model.js:18)
  → commitCreate (useHistoryCommand.js:111)
```

---

## 6. React Render Analysis

| Item | Finding | Evidence |
|---|---|---|
| `RecommendationsTab` memoized | **No** — re-renders on every parent render and every local state change | `RecommendationsTab.jsx:31` |
| `SidePanel` memoized | **No** — forwards every `VisualizerWorkspace` render | `SidePanel.jsx:33` |
| `baseImageData` prop | Stable (`useMemo`) — does not by itself re-trigger previews | `VisualizerWorkspace.jsx:80-88` |
| `schemes` prop identity | New array on every refetch → **preview effect re-runs from scratch** | `useRecommendations.js:7-11`, `RecommendationsTab.jsx:79` |
| Expensive work during render | **`toDataURL('image/png')` on every render for every scheme** | `RecommendationsTab.jsx:167` |
| Render frequency drivers | Generate → invalidate → refetch → re-render + full regen; Apply → layer mutation → invalidate layers → workspace render → tab render; `setSavedNames`/`setPreviews` → local renders | `useRecommendations.js:20`, `useLayers.js:16` |
| Zustand usage | Selector-based; correct granularity | `visualizerStore.js` |
| `useToolInteraction` per render | Returns new object each render; `CanvasStage` key listener effect depends on it → listeners re-attached on every stage render | `CanvasStage.jsx:41,60-75`, `useToolInteraction.js:189-201` |
| LayerNode memoization | Effect-guarded correctly (deps on mask/color/size) — recompute does **not** re-run on store churn; bitmap cached | `LayerNode.jsx:21-56` |

**Net:** The render tree itself is cheap (LayerNode is the well-guarded part). The unbounded cost is the **render-time `toDataURL` re-encode** and the **effect re-run on every `schemes` refetch**.

---

## 7. Memory Allocation Map (1600×1200 base)

| Allocation | Where created | Size (MB) | Lifetime | Owner | Released? |
|---|---|---|---|---|---|
| `baseImageData` ImageData | `VisualizerWorkspace.jsx:80-88` | 7.68 | workspace session | memo | on image change |
| base `<img>` decoded | `useImageElement.js:19-33` | ~7.7 + GPU | session | Konva | on unmount/URL change |
| `surfaceMasks` alpha grids (per paintable surface ×N) | `useAiAnalysis.js:75-80` | 1.92 each (~11.5 for 6) | **entire session regardless of tab/tool use** | React state | analysis change / unmount |
| `constraintAlpha` grid | `useAiAnalysis.js:51` | 1.92 | while aiSurfaceLock + ai layer | React state | deps change |
| mask cache ImageData (cap 16) | `VisualizerWorkspace.jsx:140-149` | up to 7.68×16 = **123** | session | ref Map | asset switch/unmount |
| Layer bitmap canvases (per applied layer) | `LayerNode.jsx:48-52` | 7.68 each (6 layers ≈ 46) | layer lifetime | React state | color/mask change or layer removal |
| **Scheme preview canvases (N schemes)** | `RecommendationsTab.jsx:54,68-75` | 7.68 each (**46–77 for 6–10**) | **entire tab session** | React state | tab unmount / regen replace |
| Preview regen transient buffers (baseCanvas + maskCanvas + maskData + result, per scheme in flight) | `renderSchemePreview.js:20-37`, `maskImage.js:21-26` | ~30 per scheme; **×N concurrent ≈ 180+** | milliseconds | locals | GC |
| `toDataURL` base64 strings (per scheme per render) | `RecommendationsTab.jsx:167` | ~2.7–10.7 each (**16–100+ per render**) | one frame | strings | GC |
| Scheme query cache (embedded full paint objects) | TanStack `['ai-recommendations']` | small | gcTime (5 min) | query cache | gc |
| Server: paints array | `paintRecommendation.service.js:35,90` | depends on catalog size | per request | process heap | end of request |
| Server: mock-provider analysis arrays (lab/hsl/sky/green/masks) | `mockProvider.js:68-80` | 640² ≈ 1.2M px × ~8 arrays | per analysis | locals | GC |

**The two big persistent holders are the preview canvases (46–77 MB while the tab is open) and the layer bitmaps (~46 MB) — plus up to 123 MB mask cache during brush editing.** Peak transient spikes during preview generation can exceed ~300 MB on a 1600×1200 image.

---

## 8. Canvas Lifecycle

| Canvas | Created | Reused? | Destroyed |
|---|---|---|---|
| `baseCanvas` in `renderSchemePreview` (`renderSchemePreview.js:20-24`) | per scheme per generation | No | GC after returned to state (kept as preview) |
| mask canvas in `loadMaskImageData` (`maskImage.js:21-26`) | per surface per scheme (and per layer apply, per export, per brush merge) | No | GC after `getImageData` |
| mask canvas in `surfaceMaskToPngBlob` (`maskImage.js:42-46`) | per surface per apply | No | GC after `toBlob` |
| LayerNode bitmap canvas (`LayerNode.jsx:48-52`) | **fresh canvas per recompute** (deliberate, for Konva identity) | No | replaced on next recompute |
| preview canvas in `useToolInteraction.refreshPreview` (`useToolInteraction.js:88-92`) | every 150 ms while surface-aware drag | No | replaced |
| feather canvases in `maskOps.featherMask` (`maskOps.js:32-43`) | per rasterize | No | GC |
| Export composite canvas (`ExportPanel.jsx:38-41`) | per dialog open | No | GC after dataURL |
| `canvasToThumbnailBlob` thumb (`renderSchemePreview.js:45-50`) | per save-as-concept | No | GC |

**Findings:** 6–10 preview canvases are kept alive indefinitely (tab session). During regeneration they coexist with a second full generation in flight. No canvas pooling/buffer reuse anywhere.

---

## 9. Image Processing Pipeline

```
Original upload (full res, server)
  │
  ├─▶ useImageElement → decode + downscale to ≤1600px          (once, cached) ✓
  │
  ├─▶ baseImageData = drawImage + getImageData                  (once, memoized) ✓
  │
  ├─▶ analysis (server, downscaled 640px) → masks stored as alpha PNGs
  │
  └─▶ Mask decode path — THE DUPLICATION:
        renderSchemePreview:  mask PNG → Image → draw → getImageData   ×Nschemes×Msurfaces
        applyScheme:          mask PNG → Image → draw → toBlob PNG      ×Msurfaces per apply
        LayerNode:            mask PNG → useImageElement → draw → getImageData  ×1 per layer
        ExportPanel:          mask PNG → loadImg → draw → getImageData  ×layers per open
        AISuggestionsTab:     mask PNG → loadImage → draw → getImageData  (on demand)
        useSurfaceAlphaGrids: mask PNG → draw → getImageData → Uint8    ×1 per surface
        brush merge cache:    mask PNG → draw → getImageData            ×1 per layer (cached) ✓
```

- The same mask file (e.g. `front-wall.png`) is **fetched + decoded + upscaled independently by every consumer**; in the preview path alone it is decoded **once per scheme** (`renderSchemePreview.js:31`), i.e. N× redundant for identical masks.
- `surfaceMaskToPngBlob` additionally **re-encodes the full-res mask to PNG** just to upload it back (`maskImage.js:40-50`) — decode + re-encode round-trip per surface per apply.
- Thumbnails: **only** `canvasToThumbnailBlob` uses a 256px thumbnail (`renderSchemePreview.js:45`). The on-screen preview uses the **full-res** canvas even though it is displayed at 112 px (`RecommendationsTab.jsx:167`).

---

## 10. Rendering Pipeline

- `applyPaintColor` (`colorEngine.js:118-181`) is the only paint engine. Per masked pixel it runs `rgbToLab` (3 LUT lookups, `Math.cbrt`×3) and `labToRgb` (`Math.pow`×3 + `linearToSrgb` `Math.pow`×3) plus the `out.data.set(data)` full-image copy (7.68 MB) even when only a fraction of pixels are masked.
- The `SRGB_TO_LINEAR_LUT` (`colorEngine.js:21-25`) already optimizes the forward pass; `labToRgb`/`linearToSrgb` still use `Math.pow` per channel (no inverse LUT) — the backward pass is the un-optimized half.
- `LayerNode` (the live renderer) is **correctly** raf-coalesced and caches its bitmap (`LayerNode.jsx:29-56`).
- `renderSchemePreview` re-implements the same pass from scratch per scheme and — **compositing bug** — `putImageData(result)` **overwrites** the whole canvas each iteration (`renderSchemePreview.js:37`). Since `applyPaintColor` runs with `transparentOutsideMask: true`, the result carries alpha=0 outside the mask, so each surface wipes everything outside its own mask. The final preview shows only the **last** surface painted; sky/ground and earlier surfaces render transparent. The intended "stack like the stage" (comment at `renderSchemePreview.js:12`) does not happen with `putImageData`.
- `ExportPanel` re-does the full composite per dialog open (`ExportPanel.jsx:33-77`) — identical passes as LayerNode, with no reuse of layer bitmaps.

---

## 11. Cache Analysis

| Candidate | Cached? | Evidence | Miss/recompute |
|---|---|---|---|
| Base image decode | ✓ | `useImageElement` + memo | — |
| Base ImageData | ✓ | `VisualizerWorkspace.jsx:80-88` | — |
| Layer bitmap per layer/color | ✓ | `LayerNode.jsx:18` | invalidated on color/mask change (correct) |
| Brush mask merge base | ✓ | `maskCacheRef` (cap 16, `VisualizerWorkspace.jsx:135-149`) | correct |
| **Surface masks in previews** | ✗ | `renderSchemePreview.js:31` | **N× redundant decode per generation** |
| **Scheme previews across regenerations** | ✗ | only in-memory `previews`; recomputed on every `schemes` refetch | regenerated even when paints/analysis unchanged |
| **Paint LAB for pick()** | ✗ | `catalogRecommendationProvider.js:215` | `rgbToLab` recomputed per paint per role per template per request |
| **Full catalog on list/generate** | ✗ | `paintRecommendation.service.js:35,90` | re-queried every call; rebuilds Map in `resolveScheme` (`:97`) |
| Alpha grids per surface | ✓ (but over-broad) | `useSurfaceAlphaGrids` retains all paintable surfaces all session | — |

---

## 12. Performance Bottlenecks (ranked)

| # | Type | Root cause | Location | Impact | Frequency |
|---|---|---|---|---|---|
| 1 | **CPU/Memory** | `toDataURL` re-encode of every full-res preview on every render | `RecommendationsTab.jsx:167` | Tens of MB strings + encode/decode each render; main-thread stall | every render of the tab |
| 2 | **CPU** | Full LAB pipeline re-run for all schemes on each generation/refetch, concurrent | `RecommendationsTab.jsx:66-79`, `renderSchemePreview.js:31-37` | ~30 full-image pixel passes on main thread; seconds of jank | each generate + each `schemes` refetch |
| 3 | **Memory** | 6–10 full-res preview canvases retained | `RecommendationsTab.jsx:54` | 46–77 MB persistent | tab session |
| 4 | **CPU/Network** | Same mask decoded N× per generation; re-encode round-trip on apply | `renderSchemePreview.js:31`, `maskImage.js:40-50` | redundant fetch/decode/encode | per generation/apply |
| 5 | **Server CPU** | O(roles×templates×P) `rgbToLab` on the full catalog, no precompute | `catalogRecommendationProvider.js:211-221`, `paintRecommendation.service.js:35` | scales with catalog size; blocks Node loop | per generate |
| 6 | **Memory** | All-paintable alpha grids retained regardless of use | `useAiAnalysis.js:64-87` | ~12 MB idle | session |
| 7 | **GPU** | Every layer is a full-res texture; 6+ composited per frame at any zoom | `LayerNode.jsx:61-67`, `CanvasStage.jsx:198-213` | GPU memory + compositing | continuous |
| 8 | **React** | Un-memoized tab re-renders + listener churn | `SidePanel.jsx:60-70`, `CanvasStage.jsx:41,60-75` | extra renders + add/remove listeners | on workspace renders |
| 9 | **CPU** | `pickSurfaceAtPoint`/eyedropper full-catalog LAB scan | `VisualizerWorkspace.jsx:259-265` | ~2000 `rgbToLab` per click | on click (minor) |
| 10 | **Correctness** | Preview compositing broken (last-surface-only) | `renderSchemePreview.js:37` | wrong preview output | every generation |

---

## 13. Memory Leak Report

| Check | Result | Evidence |
|---|---|---|
| Object URLs revoked | N/A — **no `createObjectURL` anywhere** in `frontend/src` (grep confirmed) | — |
| Canvases released | Preview canvases released only on **tab unmount**; regenerated ones replace state | `RecommendationsTab.jsx:54-79` |
| ImageData GC | Not rooted after consumer drops; mask cache capped at 16 | `VisualizerWorkspace.jsx:144-146` |
| Event listeners removed | ✓ keydown/keyup, ResizeObserver, window mouseup, IndexedDB subscription all cleaned | `CanvasStage.jsx:71-74`, `useToolInteraction.js:56-60,68-74`, `useIndexedDraft.js:36-39` |
| Timers cleared | ✓ (`clearTimeout` in api.js, `cancelAnimationFrame` in LayerNode, `persist.cancel`) | `LayerNode.jsx:55`, `useIndexedDraft.js:38` |
| React effects clean up | ✓ `cancelled` flags prevent post-unmount setState | `RecommendationsTab.jsx:78`, `useAiAnalysis.js:54` |
| Query cache growth | Bounded by `gcTime` (default 5 min); no `infinite:true` usage | `queryClient.js:7-14` |
| Zustand retention | Ephemeral only; **undoStack grows unbounded within a session** (non-AI-related) | `visualizerStore.js:87-97` |
| Detached DOM nodes | None identified | — |
| Canvas references persist | Yes — `previews` state, layer bitmaps, `surfaceMasks`, mask cache hold multi-MB objects for the session | §7 |

**Verdict: no classic leak (no object-URL or listener leak), but large full-res canvases are intentionally/needlessly retained, and `toDataURL` churn causes high allocation→GC pressure.**

---

## 14. CPU Hotspots

1. **`applyPaintColor` per-pixel LAB round-trip** (`colorEngine.js:145-178`) — the core cost; invoked 30× per preview generation, per layer, per export. Backward transform uses `Math.pow` per channel (no LUT).
2. **`toDataURL` PNG encoding** (`RecommendationsTab.jsx:167`) — full-res encode per scheme per render.
3. **Mask decode+upscale** (`maskImage.js:19-27`) — per consumer; no shared cache in preview path.
4. **Server `pick()` LAB scans** (`catalogRecommendationProvider.js:211-221`) — O(P) per role per template, `rgbToLab` per paint (object-allocating).
5. **Server mock analysis** (`mockProvider.js:55-441`) — per-pixel LAB/HSL arrays + BFS components + `dilate` (O(N·r²)) for 640²; runs synchronously in the request handler.
6. **Surface-aware brush flood fill** (`maskOps.js:173-285`) — per-pixel `rgbToLab` + BFS; throttled 150 ms but full-res canvases still allocated per preview tick (`useToolInteraction.js:86-92`).

---

## 15. GPU Hotspots

- **N full-res layer textures** composited every frame by Konva (`LayerNode.jsx:61-67`). Each is a 7.68 MB canvas upload; zooming to 8× (`CanvasStage.jsx:107`) does not change texture size, only the composite.
- **Surface-aware brush preview canvas** (`useToolInteraction.js:88-92`) uploaded every 150 ms while dragging.
- **Base image** drawn each frame (`CanvasStage.jsx:199`).
- No OffscreenCanvas / WebGL / worker anywhere (grep confirmed); everything runs on the 2D canvas main thread.

---

## 16. Root Cause Analysis

**Why AI Schemes consumes excessive memory and CPU:**

1. **Preview rendering duplicates the entire paint engine per scheme, at full resolution, on the main thread, concurrently** — `renderSchemePreview` is not "one extra pass"; it is `Nschemes × Msurfaces` copies of the LAB pass the stage already performs, launched together (`RecommendationsTab.jsx:66`, `renderSchemePreview.js:31-37`). This is the direct cause of the CPU spike on Generate.
2. **The rendered preview is re-encoded to a PNG data URL on every render** (`RecommendationsTab.jsx:167`) — O(scheme count × full-res PNG encode + decode) of pointless work per frame, and the source of the allocation/GC pressure and UI jank.
3. **Preview canvases are full resolution and retained in React state** (`RecommendationsTab.jsx:54`) while only displayed at 112 px — memory retained for the tab session.
4. **No cross-consumer mask/image caching** — the same mask PNG is decoded once per scheme in the preview path, again per layer, again per export, again per brush merge. The brush pipeline has a cache (`VisualizerWorkspace.jsx:135-149`); the preview path has none.
5. **Server recomputes what it could precompute/cache** — full-catalog query per request, `rgbToLab` per paint per role, `Map` rebuilds per `listRecommendations`, and `generateRecommendations` also re-fetches the full catalog immediately after (`useRecommendations.js:20` invalidates → GET re-loads everything).
6. **`useSurfaceAlphaGrids` holds every paintable surface's full-res alpha grid for the whole session** regardless of tool/tab usage (`useAiAnalysis.js:64-87`).
7. **A compositing defect** (`putImageData` overwrite at `renderSchemePreview.js:37`) makes the heavy work produce a visually wrong result (only the last surface painted), so the CPU is spent on output that doesn't even match the stage.

---

## 17. Optimization Opportunities (analysis only — NOT implemented)

**Frontend (highest impact):**
1. Memoize each scheme's rendered `dataURL` (e.g. `useMemo` per scheme id, recompute only when the canvas changes), or render the canvas via `toBlob`/object URL once per generation and keep it.
2. Render previews at **display/thumbnail resolution** (e.g. ≤256 px), not full canvas size — the card is 112 px tall (`RecommendationsTab.jsx:167`).
3. **Share/cache decoded masks** across preview generation (a single Map keyed by `mask_path`, like `maskCacheRef`), and reuse the same mask decode for all schemes in a generation.
4. Serialize or batch preview generation (or coalesce into one canvas pass that composites all surfaces per scheme) to cut peak memory.
5. Fix compositing (draw each surface's `ImageData` through a per-surface canvas + `drawImage`, or merge ImageData), or generate previews from the same code path as the stage.
6. Reuse `LayerNode` bitmaps / a memoized "painted image" for Export instead of a fresh full pass per open.
7. Lazily load alpha grids only for the surface-pick tool, or cap/drop them when idle.

**Engine (colorEngine):**
8. Add an inverse sRGB/XYZ→RGB LUT path to eliminate `Math.pow` per pixel in `labToRgb` (mirror of the existing `SRGB_TO_LINEAR_LUT`).
9. Precompute the mean-lightness pass only when actually used (already gated); consider a lower resolution pass.

**Server:**
10. Precompute `rgbToLab` for the paint pool **once per request** (or persist a LAB cache) before running `pick()`.
11. Cache `listRecommendations` per asset (the schemes only change on explicit generate); avoid re-querying the full paint table for a read.
12. Avoid the full catalog `LIMIT 100000` (`paintRecommendation.service.js:35,90`) by selecting only needed columns / paginating, and by resolving paints with the same cached list used to render.

**React:**
13. `React.memo` on `RecommendationsTab`/`SidePanel` to stop parent renders from re-encoding previews; stabilize `tool` object or narrow the key-listener effect deps (`CanvasStage.jsx:60-75`).

---

## 18. Risk Assessment

| Change area | Risk | Notes |
|---|---|---|
| Preview resolution reduction | Low | Displayed at 112 px; no visual regression expected |
| Preview dataURL memoization | Low | Pure render optimization |
| Mask sharing in previews | Medium | Must respect `width/height` changes and `mask_path` identity (same discipline as `maskCacheRef`) |
| Preview compositing fix | Medium | Changes visible output (currently wrong) — must match stage semantics; treat as correctness fix, not perf-only |
| Serializing preview generation | Low-Medium | Trade peak memory for slightly longer total time |
| colorEngine inverse LUT | Medium | Numerical-identical output required; must unit-test against `Math.pow` path |
| Server LAB precompute / recommendation caching | Low | Behavior-preserving; invalidate on catalog changes |
| Worker/OffscreenCanvas offload | High | New architecture; out of scope per constraints |

---

## 19. Production Impact

- **Generate click** on a 1600×1200 asset: ~30 full-image LAB passes concurrently + 6–10 full-res PNG re-encodes per subsequent render → multi-second main-thread jank and heap spikes that can approach/exceed a few hundred MB on typical machines; OOM risk on memory-constrained laptops/tabs.
- **Any interaction while the tab is open** (apply, save, layer select, generate) re-encodes all previews → recurring stutter and GC pauses during a workflow that should be idle.
- **Wrong preview output** (last-surface-only, transparent background) means dealers can't trust the thumbnail, undermining the feature's core purpose.
- Server `generate` cost scales linearly with catalog size; on large catalogs the Node event loop blocks for the duration of `pick()`.

---

## 20. Prioritized Action Plan

| Priority | Action | Type | Est. effect |
|---|---|---|---|
| P0 | Fix preview compositing (`renderSchemePreview.js:37`) | Correctness | Trustworthy thumbnails |
| P0 | Memoize/cache `toDataURL` per scheme; stop per-render re-encode (`RecommendationsTab.jsx:167`) | CPU/Memory | Removes largest recurring stall |
| P0 | Render previews at display resolution (~256 px) | Memory/CPU | Cuts preview memory ~30× (46–77 MB → ~2 MB) |
| P1 | Share decoded masks across schemes in a generation (`renderSchemePreview.js:31`) | CPU/Network | N→1 mask decodes |
| P1 | Serialize/batch preview generation (`RecommendationsTab.jsx:66`) | Peak memory | Caps concurrent buffers |
| P1 | Precompute paint LAB once per server request (`catalogRecommendationProvider.js:215`) | Server CPU | O(P)→O(P) with small constant; avoids re-deriving |
| P1 | Cache `listRecommendations` / avoid full-table paint query on reads | Server CPU/IO | Removes redundant full-catalog loads |
| P2 | Inverse-LUT for `labToRgb` (`colorEngine.js:75`) | CPU | ~2× faster per-pixel backward pass |
| P2 | Reuse layer bitmaps in Export; `React.memo` tab; lazy alpha grids | Memory/React | Reduces idle retention and churn |
| P3 | Worker/OffscreenCanvas offload of LAB passes | CPU/UI | Keeps UI thread free (larger architectural change) |

---

**Report complete.** All claims cite specific files/lines from the current implementation. No code was modified.
