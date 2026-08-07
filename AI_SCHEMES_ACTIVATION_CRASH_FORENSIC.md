# Forensic Report — AI Schemes Module Browser Crash on Activation (P0)

**Investigation type:** Production P0 forensic — frontend initialization path only.
**Subject:** Clicking the **AI Schemes** rail button (`SidePanel.jsx:22`) freezes/crashes the browser before any user-initiated network action.
**Conclusion:** Frontend-only, renderer-level **memory/CPU crash** triggered automatically on module mount by the preview pipeline. **Repair** is recommended; removal is not justified by the code.

> **Exact crashing statement (Primary Root Cause):**
> `frontend/src/features/visualizer/panels/RecommendationsTab.jsx:66-76` — the mount-time `useEffect` body that executes `Promise.all(schemes.map((scheme) => renderSchemePreview({ baseImageData, scheme, ... })))` for **every persisted scheme at full working resolution (1600×1200)**, whose synchronous allocation prefix is at `frontend/src/features/visualizer/lib/renderSchemePreview.js:20-24` and whose per-surface amplifiers are `renderSchemePreview.js:31-37` → `colorEngine.js:118-181` → `maskImage.js:19-27`.

---

## 1. Executive Summary

1. The **AI Schemes** button is the icon-rail button `{ id: 'recommendations', label: 'AI Schemes', Icon: Wand2 }` in `SidePanel.jsx:22`. It only calls `setActive('recommendations')` (`SidePanel.jsx:44`), which mounts `RecommendationsTab` (`SidePanel.jsx:65`). There is no navigation, no backend call, and no generation triggered by the click itself.
2. On mount, `RecommendationsTab` runs **one `useEffect`** (`RecommendationsTab.jsx:58-79`) that — the moment **analysis exists**, the **base image is decoded**, and **at least one scheme is present** — automatically launches the full preview-generation pipeline for **every** scheme via `Promise.all`, with **no user action**.
3. `renderSchemePreview` (`renderSchemePreview.js:17-41`) creates a **full-resolution (1600×1200) canvas** per scheme, copies the 7.68 MB base `ImageData` into it, and for **each surface** decodes the mask at full resolution and runs the **full-image per-pixel LAB recolor** (`colorEngine.js:118-181`). All schemes run **concurrently** (`RecommendationsTab.jsx:66`).
4. The combination — a **synchronous ~92–153 MB canvas-allocation burst** (the prefix executed before the effect's first `await`/mask fetch), immediately followed by **concurrent per-surface allocations of ~23 MB each** (6–10 schemes × ~5 surfaces ≈ 140–230 MB live transients on top of an already memory-pressured workspace) — OOM-kills the renderer ("sometimes the renderer process is killed") and/or blocks the main thread for seconds ("browser freezes").
5. **No network request is observed** because the crash happens inside the synchronous allocation prefix, which runs **before** the effect's awaited mask `fetch()` calls (`maskImage.js:13`) are dispatched, and the **Generate** mutation is **never invoked** by activation (nothing calls `generate.mutateAsync()` on mount).
6. **Precondition (critical):** the crash requires `schemes.length > 0`. Schemes are **only ever created** by `generateRecommendations` and are **persisted in the database** (`paintRecommendation.service.js:63-75`, `paintRecommendation.model.js:6-20`); analysis does **not** auto-seed them. Therefore the reported "no generation has started" means the dealer did not generate *in this session* — the schemes pre-exist from an earlier generate and are returned on mount by `useRecommendations` (`useRecommendations.js:7-11`). **With a genuinely empty scheme set, activation is cheap and cannot crash** (Section 11).
7. The previously-suspected `toDataURL` line (`RecommendationsTab.jsx:167`) is **not** the activation crash: on a fresh mount `previews` is `{}`, so line 165–170 renders the "Rendering preview…" placeholder and `toDataURL` is never called (Section 10).

---

## 2. Complete Component Tree

```
VisualizerWorkspace (VisualizerWorkspace.jsx:38)                      ← always mounted once project loads
├─ header … (no AI Schemes entry)
├─ Toolbar (Toolbar.jsx:9)                                            ← NO "AI Schemes" button (verified)
├─ CanvasStage (VisualizerWorkspace.jsx:422)
├─ SidePanel (VisualizerWorkspace.jsx:291 → SidePanel.jsx:33)
│  ├─ nav rail — SECTIONS (SidePanel.jsx:16-28)
│  │   └─ button id='recommendations' label='AI Schemes' (SidePanel.jsx:22,40-56)
│  │       onClick={() => setActive('recommendations')}  (SidePanel.jsx:44)
│  └─ content — ONE active section only (SidePanel.jsx:60-70)
│      └─ active==='recommendations' → RecommendationsTab (SidePanel.jsx:65)
│          ├─ useToast (toast.jsx:50)                                  [context]
│          ├─ useAiMeta (useAiAnalysis.js:8)                           [query]
│          ├─ useAssetAnalysis (useAiAnalysis.js:15)                   [query]
│          ├─ useRecommendations (useRecommendations.js:6)             [query]
│          ├─ useGenerateRecommendations (useRecommendations.js:16)    [mutation, idle]
│          ├─ useApplySurface (useApplySurface.js:21)                  [queries + functions]
│          │   ├─ useCreateLayer (useLayers.js:12)
│          │   ├─ useHistoryCommand (useHistoryCommand.js:39)
│          │   │   ├─ useUpdateLayer / useDeleteLayer / useRestoreLayer (useLayers.js:23,42,51)
│          │   │   ├─ useAppendHistory / useHistoryList (useHistoryEntries)
│          │   │   └─ useVisualizerStore (zustand)
│          │   └─ useLayersList (useLayers.js:4)
│          ├─ useSaveConcept (useConcepts.js:20)                       [mutation, idle]
│          └─ useState previews/savedNames + useRef previewGenRef (RecommendationsTab.jsx:54-56)
│          └─ useEffect (RecommendationsTab.jsx:58-79)  ← THE CRASH SITE
├─ Inspector (VisualizerWorkspace.jsx:440)
└─ ExportPanel (VisualizerWorkspace.jsx:457)
```

Only the rail button and `RecommendationsTab` are new work when AI Schemes is activated. The workspace (including `useSurfaceAlphaGrids` at `VisualizerWorkspace.jsx:109`, which holds all alpha grids) is always mounted and unaffected by the click.

---

## 3. Initialization Flow Diagram

```
Click "AI Schemes" (SidePanel.jsx:22,44)
  └─▶ setActive('recommendations')                 [SidePanel local state]
        └─▶ SidePanel re-render (unmounts previous tab, e.g. LayersTab)
              └─▶ RecommendationsTab MOUNTS  (SidePanel.jsx:65)
                    ├─ 4 queries subscribe + schedule GETs (analysis, recommendations, layers, meta)
                    ├─ 2 mutations created (idle)
                    ├─ 1 zustand subscription (setActiveLayerId)
                    ├─ 1st render — schemes=[], previews={} → CHEAP (button + "No schemes yet")
                    ├─ useEffect#1 runs — guard sees !analyzed and/or empty schemes → setPreviews({}) → CHEAP
                    │
                    ▼  queries resolve: analysis.analyzed=true AND schemes=[persisted rows]
                    ├─ re-render (still cheap: previews={}, placeholder only)
                    ├─ useEffect#2 re-runs (RecommendationsTab.jsx:66)   ★ CRASH STARTS
                    │     Promise.all(schemes.map(renderSchemePreview))
                    │       per scheme (synchronous prefix):
                    │         canvas 1600×1200 alloc          (renderSchemePreview.js:20-22)
                    │         putImageData(baseImageData)      (renderSchemePreview.js:24)
                    │       then first await → mask GET dispatch (maskImage.js:13)
                    │       per surface (concurrent chains):
                    │         loadMaskImageData → 7.68 MB canvas + 7.68 MB ImageData (maskImage.js:21-26)
                    │         applyPaintColor → new 7.68 MB ImageData + per-pixel LAB (colorEngine.js:118-181)
                    │         ctx.putImageData(result)         (renderSchemePreview.js:37)
                    ▼
            Browser freeze / renderer OOM-kill   ←  before the effect's awaits fully run
```

---

## 4. Event Flow Diagram (click → crash)

```
button#recommendations (SidePanel.jsx:44)  onClick={() => setActive(id)}
  └─▶ (state change, no async) 
        └─▶ RecommendationsTab mount commit
              └─▶ React Query observers subscribe (fetch scheduled async)
              └─▶ useEffect post-commit: guard → setPreviews({})
              └─▶ [analysis + schemes data arrive → re-render → effect#2]
                    └─▶ Promise.all(schemes.map(renderSchemePreview))        RecommendationsTab.jsx:66
                          └─▶ per scheme: new canvas(1600×1200) + putImageData  renderSchemePreview.js:20-24
                          └─▶ await loadMaskImageData(url)                   renderSchemePreview.js:31
                                └─▶ new Image(); img.src = fileUrl(mask)     maskImage.js:9-13   ← first network
                          └─▶ applyPaintColor(base, mask, target, 0.95, {transparentOutsideMask:true, lightnessBlend:0.45})  renderSchemePreview.js:33
                          └─▶ ctx.putImageData(result)                      renderSchemePreview.js:37
                    ▼
             Renderer killed / main thread blocked
```

No `fetch()`/mutation occurs from the click itself. The `Generate` mutation (`useRecommendations.js:18-21`) is never called on this path.

---

## 5. React Lifecycle Timeline

| Step | Phase | What runs | Cost |
|---|---|---|---|
| 1 | Click handler | `setActive('recommendations')` | trivial |
| 2 | Commit | `RecommendationsTab` mount; 4 queries subscribe; zustand selector `setActiveLayerId` | trivial |
| 3 | Render #1 | schemes=[], previews={} → button + hint + placeholder | trivial |
| 4 | Effects #1 | guard (`!analyzed` or empty) → `setPreviews({})` | trivial |
| 5 | Async | analysis + recommendations GETs resolve | network |
| 6 | Render #2 | same as #3 (previews still {}) | trivial |
| 7 | Effects #2 | **`Promise.all(schemes.map(renderSchemePreview))`** | **CRASH** |
| 8 | (never reached) | `setPreviews(next)` → render #3 → `toDataURL` at `:167` | would also be heavy |

The crash is at lifecycle step **7** (a `useEffect` triggered by query data), **before any user action** beyond clicking the rail button.

---

## 6. Hook Execution Timeline (mount order in `RecommendationsTab`)

| Hook | Executes | Allocates | State change | Re-render? |
|---|---|---|---|---|
| `useToast` (`:32`) | render | — | — | no |
| `useAiMeta` (`:33`) | render | — | — | no |
| `useAssetAnalysis` (`:36`) | render | — | — | no (query) |
| `useRecommendations` (`:37`) | render | — | — | no (query) |
| `useGenerateRecommendations` (`:38`) | render | — | — | no |
| `useApplySurface` (`:39`) | render | — | — | no |
| `useSaveConcept` (`:40`) | render | — | — | no |
| `useMemo surfacesByClass` (`:44-48`) | render | `Map` | — | deps `[analysis]` |
| `useState previews/savedNames` (`:54-55`) | render | `{}` | — | — |
| `useRef previewGenRef` (`:56`) | render | number | — | — |
| `useEffect` (`:58-79`) | post-commit | **N canvases + N ImageData + per-surface ImageData** | `setPreviews` | **yes** |
| `useEffect` cleanup (`:78`) | re-run/unmount | — | `cancelled=true` | — |

No `useLayoutEffect`, no `useCallback`, no `createObjectURL`, no worker, no OffscreenCanvas anywhere in the path.

---

## 7. State Update Timeline

1. `setActive('recommendations')` — SidePanel local state → single re-render.
2. `setPreviews({})` from effect#1 guard — new object identity, but the effect does **not** depend on `previews`, so it does **not** re-run. **No loop** (Section 13).
3. React Query observer updates (`analysis`, `schemes`) → render #2 → effect#2 → crash.
4. No Zustand updates fire from the tab mount (`useApplySurface` only calls `setActiveLayerId` inside apply functions, never on mount).

---

## 8. Canvas Allocation Map (working resolution 1600×1200 = 7.68 MB/canvas — `useImageElement.js:3`)

| Allocation | Site | Size | Lifetime | Crash-relevant |
|---|---|---|---|---|
| Base `ImageData` | `VisualizerWorkspace.jsx:80-88` | 7.68 MB | session | retained |
| Decoded base `<img>` | `useImageElement.js:19-33` | ~7.7 MB | session | retained |
| Alpha grids (all paintable surfaces) | `useAiAnalysis.js:64-87` | 6×1.92 ≈ 11.5 MB | session (always, all tabs) | retained |
| Constraint alpha | `useAiAnalysis.js:41-58` | 1.92 MB | while surface lock | retained |
| **Preview base canvas ×N** | **`renderSchemePreview.js:20-22`** | **N × 7.68 MB** | transient | **synchronous burst on mount** |
| **putImageData copy ×N** | **`renderSchemePreview.js:24`** | **N × 7.68 MB** | transient | **synchronous burst on mount** |
| Mask canvas + mask ImageData per surface per scheme | `maskImage.js:21-26` | ~15.4 MB each | transient, concurrent | amplifier |
| `applyPaintColor` result ImageData per surface | `colorEngine.js:121` | 7.68 MB each | transient, concurrent | amplifier |
| Mask cache (brush) | `VisualizerWorkspace.jsx:135-149` | up to 123 MB | session (while brushing) | retained |
| Layer bitmaps | `LayerNode.jsx:48-52` | 7.68 MB × layers | session | retained |
| Preview canvases held in state (post-crash) | `RecommendationsTab.jsx:75` | 6–10 × 7.68 = 46–77 MB | tab session | secondary |
| `toDataURL` strings per render | `RecommendationsTab.jsx:167` | 2.7–10.7 MB each | one frame | secondary (not reached on activation) |

**Peak during activation:** existing retained ~35–90 MB (idle workspace) **+** synchronous burst **N×(7.68+7.68) = 92–153 MB for 6–10 schemes** **+** concurrent per-surface transients up to ~140–230 MB. **Total 250–500+ MB of live canvas/ImageData**, all on the main thread, within a second — the OOM kill point.

---

## 9. Image Processing Pipeline (runs automatically on activation)

```
analysis (server, 640px mock provider) ──▶ persisted ai_surfaces + alpha-PNG masks on disk
base image ──▶ useImageElement downscale ≤1600px ──▶ baseImageData (7.68 MB)
        │
        └─▶ AUTOMATIC on AI Schemes activation (no button press):
             N schemes × M surfaces:
               mask PNG ──▶ GET /files/... (maskImage.js:13)          ← one fetch per scheme per surface
               ──▶ new Image → draw to 1600×1200 canvas (maskImage.js:25)
               ──▶ getImageData (7.68 MB) (maskImage.js:26)
               ──▶ applyPaintColor: full 1.92M-px pass, RGB→LAB→RGB per pixel (colorEngine.js:145-178)
               ──▶ new ImageData (7.68 MB) + set copy (colorEngine.js:122)
               ──▶ putImageData overwrite (renderSchemePreview.js:37)  ← also a correctness bug: only last surface survives
```

The **entire LAB paint engine runs automatically on module mount** — image decode, mask decode, surface compositing, and LAB conversion all execute before the Generate button is ever pressed.

---

## 10. Render Analysis

| Item | Finding | Evidence |
|---|---|---|
| Mount render cost | Trivial (schemes=[], previews={}) | `RecommendationsTab.jsx:121-206` |
| `toDataURL` on activation | **Not called** — `previews` empty → placeholder branch | `RecommendationsTab.jsx:165-175` |
| `toDataURL` general | Runs on **every render** once previews exist — a secondary hotspot, but not the activation crash | `RecommendationsTab.jsx:167` |
| Post-crash render | Would call `toDataURL` ×N and re-encode full-res PNGs | `RecommendationsTab.jsx:167` |
| Effect re-runs | Only on dep changes (`[analyzed, baseImageData, width, height, schemes, surfacesByClass]`) — no per-render effect churn | `RecommendationsTab.jsx:79` |
| Dep stability | `analysis`, `baseImageData`, `schemes` are stable React Query/memo references; `width/height` scalars | §13 |

**Synchronous work during the crash render/effect:** the effect body itself is cheap; the expensive part is the **async `Promise.all` body**, whose synchronous prefix (canvas creation + `putImageData`) runs in the same task and blocks the main thread before the first `await`.

---

## 11. Memory Analysis

- **Precondition is real:** schemes come from `useRecommendations` (`useRecommendations.js:7-11`) → `GET /api/assets/:id/ai/recommendations` → `listForAsset` returns **persisted rows** (`paintRecommendation.service.js:89-93`; rows created only by `generateRecommendations` at `:63-75`). Analysis does not seed them (`houseUnderstanding.service.js` creates no scheme rows). So "no generation in this session" is compatible with schemes being present from an earlier persisted generate.
- **Empty-schemes activation is cheap and cannot crash** — verified: effect runs `Promise.all([])`, renders nothing heavy. This is an important forensic boundary: if the environment truly has zero persisted recommendations, the reported symptom would not reproduce on this code.
- **Persisted-schemes activation exceeds safe memory on constrained hardware:** retained workspace (~35–90 MB) + synchronous burst (92–153 MB) + concurrent per-surface transients (~140–230 MB). On 2–4 GB machines and Chrome's default renderer limits this kills the renderer.
- No `createObjectURL` exists anywhere; no listener/timer leaks were found (consistent with the prior audit); the crash is **allocation-based**, not a leak.

---

## 12. CPU Analysis

- `applyPaintColor` (`colorEngine.js:118-181`) does a per-pixel RGB→XYZ→LAB→…→RGB round-trip (`rgbToLab` `:63`, `labToRgb` `:75`, `Math.pow`×6 via `linearToSrgb`/`labToXyz` per channel) plus a full 7.68 MB `out.data.set(data)` copy (`:122`), over **1.92M pixels per surface pass**.
- Activation launches up to **N×M = 30 full-image passes concurrently** (`RecommendationsTab.jsx:66`, `renderSchemePreview.js:31-37`) ≈ 57.6M pixel-round-trips plus ~30 full ImageData copies — **multi-second main-thread block**, and the reason the tab appears frozen even before OOM.
- The mean-lightness pre-pass (`colorEngine.js:130-143`) adds a sampled second pass per surface.

---

## 13. Infinite Loop Analysis — **none found (verified)**

| Suspected loop | Verdict | Evidence |
|---|---|---|
| Effect → `setPreviews({})` → re-render → effect | **No loop.** `previews` is not a dependency of the effect; deps are reference-stable | `RecommendationsTab.jsx:58-79` |
| `baseImageData` identity churn | **No.** memoized on `[baseImage, width, height]`; `useImageElement` state is stable between loads | `VisualizerWorkspace.jsx:80-88`, `useImageElement.js:8-38` |
| `analysis`/`surfacesByClass` churn | **No.** both memo/query-stable | `RecommendationsTab.jsx:44-48` |
| `schemes` identity loop | **No.** only changes on refetch; effect re-runs once per refetch | `useRecommendations.js:7-11` |
| Recursive promise / stack overflow | **No.** `renderSchemePreview` is iterative per scheme, bounded by surface count | `renderSchemePreview.js:17-41` |
| `hydrateHistory` loop | **No.** guarded by `hydrated` ref | `useHistoryCommand.js:54-77` |

The freeze is **not** an infinite render loop, stack overflow, or recursive state update. It is a **finite but catastrophic allocation/CPU burst** on the main thread.

---

## 14. API Execution Analysis — why "no network request"

1. The rail click performs **no network work** — it only sets local state (`SidePanel.jsx:44`).
2. React Query GETs for analysis/recommendations/layers/meta are initiated on mount, but the renderer can be killed **before their effects fully drive the heavy pipeline**, and — decisively — the crash occurs in the **synchronous allocation prefix** of `Promise.all` (`RecommendationsTab.jsx:66` → `renderSchemePreview.js:20-24`), which executes **before** the effect's awaited mask fetches (`maskImage.js:9-13`) are dispatched. At the instant the renderer is killed, **no request is in flight**.
3. The **Generate mutation is never invoked on activation** — `generate.mutateAsync()` is called only from `runGenerate` (`RecommendationsTab.jsx:83`), which requires the button at `:136`. So no `POST /ai/recommendations` can exist. The "no request" observation is therefore **consistent with a crash before the effect's first `await`** — not with a backend failure.
4. Caveat for completeness: if the tab survives the synchronous prefix, mask GETs do appear; the reporter's "no request" reflects the renderer being killed during the prefix on the affected machine.

---

## 15. Browser Crash Root Cause

**Classification: Out of Memory + main-thread blocking from a synchronous full-resolution canvas/ImageData allocation storm.**

- **Trigger:** mount of `RecommendationsTab` with persisted schemes present.
- **Exact statement:** `RecommendationsTab.jsx:66-76` (`Promise.all(schemes.map(async (scheme) => { const canvas = await renderSchemePreview(...); ... }))`), with the allocation-heavy prefix at `renderSchemePreview.js:20-24` and the per-surface amplifiers at `renderSchemePreview.js:31-37`/`colorEngine.js:118-181`/`maskImage.js:19-27`.
- **Why it kills the renderer:** ~250–500+ MB of live canvas/ImageData on the main thread within a second, on top of an already-memory-pressured 1600×1200 workspace, plus ~30 concurrent full-image LAB passes. On low-memory hardware this exceeds the renderer's heap limit → process killed. On healthier machines it is a multi-second hard freeze.
- **It is not:** an infinite loop, a stack overflow, a React state recursion, a network failure, `toDataURL` (never reached on activation), or recommendation generation itself.

---

## 16. Supporting Code Evidence

| # | Finding | File:Line |
|---|---|---|
| 1 | AI Schemes entry is the SidePanel rail button; `setActive` only | `SidePanel.jsx:22,44` |
| 2 | Conditional mount of the tab | `SidePanel.jsx:65` |
| 3 | Mount effect runs the whole preview pipeline automatically | `RecommendationsTab.jsx:58-79` |
| 4 | Concurrent `Promise.all` over all schemes | `RecommendationsTab.jsx:66` |
| 5 | Full-res canvas + `putImageData` copy (synchronous prefix) | `renderSchemePreview.js:20-24` |
| 6 | Mask fetched/decoded once **per scheme** (no cache) | `renderSchemePreview.js:31`, `maskImage.js:7-27` |
| 7 | Full-image per-pixel LAB pass + new ImageData | `colorEngine.js:118-181` (`:121-122`, `:145-178`) |
| 8 | `putImageData` overwrite — compositing defect | `renderSchemePreview.js:37` |
| 9 | Schemes only created by generate; persisted in DB | `paintRecommendation.service.js:63-75`; `paintRecommendation.model.js:6-20` |
| 10 | `listRecommendations` returns persisted rows → non-empty on mount | `paintRecommendation.service.js:89-93` |
| 11 | Analysis does not seed schemes; `analyzed` shape | `houseUnderstanding.service.js:107-113` |
| 12 | Working resolution 1600×1200 → 7.68 MB/canvas | `useImageElement.js:3` |
| 13 | Base ImageData retained in parent | `VisualizerWorkspace.jsx:80-88` |
| 14 | Alpha grids retained for all surfaces all session | `useAiAnalysis.js:64-87` |
| 15 | Generate mutation idle on activation; only fired from button | `useRecommendations.js:16-21`, `RecommendationsTab.jsx:81-88,136` |
| 16 | `toDataURL` only reached once previews exist | `RecommendationsTab.jsx:165-175` |
| 17 | No mask cache in preview path | `renderSchemePreview.js:31` vs brush cache `VisualizerWorkspace.jsx:135-149` |

---

## 17. Risk Assessment

| Risk | Severity | Basis |
|---|---|---|
| Renderer OOM/freeze on activation with ≥1 persisted scheme | **Critical** | §11/§15 |
| Any re-render with previews present re-encodes full-res PNGs (`toDataURL`) | High | `RecommendationsTab.jsx:167` |
| Preview compositing produces wrong output (only last surface painted) | High (correctness) | `renderSchemePreview.js:37` |
| N× redundant mask decodes in preview path | Medium | `renderSchemePreview.js:31` |
| Preview canvases retained at full res while shown at 112 px | Medium | `RecommendationsTab.jsx:54,169` |
| Alpha grids + base ImageData retained for whole session | Low-Medium | `useAiAnalysis.js:64-87`, `VisualizerWorkspace.jsx:80-88` |
| "No network request" misattribution to backend | Medium (diagnostic) | §14 |

---

## 18. Repair vs Remove Decision

**Verdict: REPAIR.** Removal is **not** justified.

- The architecture is fundamentally sound: server produces **catalog-only** schemes (`paintRecommendation.service.js:1-7`), and the browser uses **one** paint engine (`colorEngine.js`) consistently across stage, previews, and export. The defect is a single, well-localized hot path (`RecommendationsTab.jsx:58-79` + `renderSchemePreview.js`), not an architectural flaw. There is no evidence the module "cannot be safely stabilized."
- **Repair direction (analysis only, not implemented here):**
  1. **P0 — Cut preview resolution to display size (~256 px)**, as `canvasToThumbnailBlob` already does (`renderSchemePreview.js:45-54`). Reduces per-canvas cost ~30× (7.68 MB → ~0.25 MB), removing both the synchronous burst and the concurrent transient OOM. This alone neutralizes the crash.
  2. **P0 — Do not run the pipeline with zero user intent / serialize it.** Gate the mount effect (e.g., run previews only after schemes exist and only when the tab is active and not while a mutation is pending) and cap concurrency instead of `Promise.all` over all schemes (`RecommendationsTab.jsx:66`).
  3. **P1 — Cache encoded previews** so renders never re-encode full-res PNGs (`RecommendationsTab.jsx:167`).
  4. **P1 — Cache decoded masks across schemes** in the preview path (mirror `VisualizerWorkspace.jsx:135-149`).
  5. **P1 — Fix compositing** (`renderSchemePreview.js:37`) so previews match the stage.
  6. **P2 — Add an error boundary** so any future render-time failure degrades one card, not the SPA.

---

## 19. Recommended Next Steps

1. **Confirm the precondition on the reported machine:** check whether the asset has persisted rows in `paint_recommendations` (i.e., `GET /api/assets/:id/ai/recommendations` returns ≥1 scheme). The crash is impossible on this code with an empty scheme set.
2. **Confirm with a profile:** with DevTools → Performance, click AI Schemes; expect a single main-thread burst originating from `renderSchemePreview` (canvas alloc + `putImageData` + `applyPaintColor`). Verify the renderer process dies during the synchronous prefix (no mask requests in flight) on the affected hardware.
3. **Apply repair P0 (preview resolution + gating/concurrency)** and re-verify: activation must stay idle until schemes exist, and preview work must run at ~256 px.
4. **Regression test:** analyze → generate → activate/deactivate AI Schemes repeatedly; verify no freeze, no OOM, correct previews, and that the Generate POST now appears normally.
5. **Document** the persistence behavior (schemes survive across sessions) so future debugging of "I never generated but schemes exist" is not re-litigated.

---

**Report complete.** All conclusions were derived by tracing the current implementation from the AI Schemes button; no code was modified.
