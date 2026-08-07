# Incident Report — "Generate AI Schemes" Freezes the Browser, No Network Request Sent

**Severity:** P0 (production UI freezes/crashes)
**Component:** AI Schemes — `RecommendationsTab` (frontend)
**Verdict:** Frontend-only defect. **Repair** (not removal).
**Exact crashing statement:** `frontend/src/features/visualizer/panels/RecommendationsTab.jsx:167`

```jsx
src={previews[scheme.id].toDataURL('image/png')}
```

`toDataURL('image/png')` runs **during React render**, on every scheme preview, at full canvas resolution. When the user clicks **Generate AI Schemes**, the mutation's `isPending` state change forces a synchronous re-render *before* the mutation's `fetch()` is even invoked — and that re-render re-encodes every full-resolution preview canvas. The main thread is blocked long enough (and on constrained hardware, hard-crashes) that the browser **never reaches the network call**. No request appears in DevTools because none was ever made.

---

## 1. Incident Summary

- **Action:** Clicking the **Generate AI Schemes** button (`RecommendationsTab.jsx:136`).
- **Result:** The tab freezes / the browser tab crashes. The DevTools Network tab shows **no** `POST /api/assets/:assetId/ai/recommendations` request.
- **Scope:** Entirely frontend. The failure occurs during the React render triggered by the mutation's `pending` state, **before** `fetch()` is called (`api.js:14`).
- **Direct cause:** Render-time, full-resolution PNG re-encode of every scheme preview at `RecommendationsTab.jsx:167`, executed synchronously during the `isPending` re-render flush that precedes the mutation's network call.
- **Precondition:** At least one scheme preview canvas must already exist in `previews` state (i.e., the user already generated once in the same tab session, or returned to the tab with cached schemes whose preview effect had completed). The very first generation (empty `previews`) does not hit the crash on click.

---

## 2. Impact

- **Dealers cannot re-generate a scheme batch** — the single most common action after inspecting a first batch ("regenerate") freezes or kills the tab.
- Data loss of in-progress work: the freeze takes down the entire SPA (no error boundary), losing any unsaved layer edits in the same tab.
- On memory-constrained hardware the allocation spike is a **hard OOM crash**, not merely jank.
- Supporting the reported symptom ("no request sent"): because the fetch is deferred behind the blocking re-render, the crash looks like a frontend hang with **zero network activity**, which is why it survived normal backend monitoring.

---

## 3. Timeline

| # | Phase | Evidence |
|---|---|---|
| 1 | User analyzes an asset (AI Understand tab) | `AIAnalyzeTab.jsx` → `useAnalyzeAsset` → `ai.analyze` |
| 2 | User opens AI Schemes, generates a first batch; previews render into `previews` state | `RecommendationsTab.jsx:58-79`, `:165-175` |
| 3 | User clicks **Generate AI Schemes** again to refresh the batch | `RecommendationsTab.jsx:136` |
| 4 | Mutation dispatches `pending`; React flushes a synchronous re-render | `useRecommendations.js:18-21` |
| 5 | That re-render executes `toDataURL('image/png')` per existing preview | **`RecommendationsTab.jsx:167`** |
| 6 | Main thread blocks (multi-second stall / OOM); the mutation's `fetch()` microtask never runs | `api.js:136-137` → `api.js:14` |
| 7 | Tab appears frozen / crashes; Network tab shows no request | observed |

---

## 4. Environment

| Item | Value | Source |
|---|---|---|
| Browser | Chrome/Edge (Chromium), desktop | incident report |
| React | `^18.3.1` (installed 18.3.1) | `frontend/package.json` |
| @tanstack/react-query | `^5.101.4` (installed 5.101.4) | `frontend/package.json` |
| Working resolution | 1600×1200 = 1,920,000 px = **7.68 MB** RGBA per ImageData/canvas | `canvas/useImageElement.js:3` (`MAX_DIMENSION = 1600`) |
| Preview canvas count | 6–10 canvases (batch size from `aiMeta` / server clamp) | `RecommendationsTab.jsx:137`, `:66-79` |

---

## 5. Reproduction Steps

1. Open a project with an asset; run AI analysis (any provider).
2. Open the **AI Schemes** tab; click **Generate N schemes** once; wait for previews to render (cards show images).
3. Click **Generate N schemes** a second time.
4. Observe: UI freezes; if left long enough, the browser tab crashes. DevTools → Network shows **no** `POST .../ai/recommendations` request.

Same crash triggers on any interaction that re-renders the tab while previews exist and a mutation/state churn occurs (e.g., applying a scheme, saving a concept, or a parent re-render) — because `toDataURL` runs on **every render**, not just on the Generate click.

---

## 6. Observed Symptoms

- **No network request** — the defining symptom. DevTools Network stays empty.
- **Freeze/crash** — main thread unresponsive, tab may be killed by the browser (Out of Memory).
- **Recurring jank** — even when it survives, every re-render with previews present stalls the UI (documented in `AI_SCHEMES_AUDIT.md` §12 #1).

These three symptoms are consistent: the render-time encode happens **before** the network call, so a heavy encode produces "freeze with no request."

---

## 7. Investigation Scope

Searched the click path end-to-end (`RecommendationsTab.jsx` → `useRecommendations.js` → `api.js` → backend routes), the parent render path (`VisualizerWorkspace.jsx` → `SidePanel.jsx` → `RecommendationsTab.jsx`), the preview renderer (`renderSchemePreview.js`), the shared color engine (`colorEngine.js`), the mask loader (`maskImage.js`), and the **installed** `@tanstack/query-core` 5.101.4 source for the mutation scheduling. No backend involvement was found — the defect never reaches `fetch`.

---

## 8. Code Trace (click → crash)

```
RecommendationsTab.jsx:136   <Button onClick={runGenerate} ...>
RecommendationsTab.jsx:81    async function runGenerate() {
RecommendationsTab.jsx:83      await generate.mutateAsync();
useRecommendations.js:18-21    useMutation({ mutationFn: (count) => ai.generateRecommendations(assetId, count) })
api.js:136-137                 generateRecommendations → request(path, {...}, LONG_TIMEOUT_MS)   ← WOULD call fetch
api.js:14                      fetch(`${BASE_URL}${path}`, ...)                                 ← NEVER REACHED

    │  Step A: mutation dispatches { type: "pending" } → generate.isPending = true
    │          → React observer setState → schedules a re-render
    ▼
RecommendationsTab.jsx:167   src={previews[scheme.id].toDataURL('image/png')}    ← CRASH STATEMENT
    │  React flushes this re-render synchronously at the end of the click event
    │  (discrete event), BEFORE the mutation's queued microtasks run.
    │  Each toDataURL() = full-res PNG encode (~200-800ms) + ~2.7-10.7 MB base64
    │  string + browser decode of another ~7.7 MB bitmap. ×6-10 schemes.
    ▼
    Freeze / OOM crash. The fetch microtask never executes → no network request.
```

---

## 9. Root Cause

**Single root cause:** `toDataURL('image/png')` is executed **inside the render function** at `RecommendationsTab.jsx:167`. On click, the mutation's `isPending` change forces that render to run synchronously (React 18 discrete-event flush) *before* the mutation body reaches `fetch()`. The render re-encodes every full-resolution preview canvas (1600×1200), blocking the main thread for seconds or OOM-killing the tab, so **the fetch is never initiated**. The symptom "no network request sent" is the direct signature of a crash that occurs **between** the mutation's `pending` dispatch and its `mutationFn` invocation.

---

## 10. Why No Network Request Was Sent (proof from the installed library)

The ordering is proven by the installed `@tanstack/query-core@5.101.4` source (`frontend/node_modules/@tanstack/query-core/build/modern/mutation.js` and `retryer.js`):

```js
// Mutation.execute()
this.#dispatch({ type: "pending", variables, isPaused });   // (A) sync → observer setState
await this.options.onMutate?.(variables, mutationFnContext); // (B) hook undefined → await yields → microtask
...
const data = await this.#retryer.start();                    // (C) fn() called inside run()
```

```js
// Retryer.start()
start: () => {
  if (canStart()) { run(); }          // run() calls config.fn() → ai.generateRecommendations → fetch()
  ...
}
```

Because there is an `await` (step B) between the `pending` dispatch (A) and `retryer.start()` (C), the `mutationFn` — and therefore `fetch()` — is scheduled as a **microtask**. React 18 flushes a discrete event's state update (the `isPending` re-render) **synchronously at the end of the click handler, before those microtasks run**. That re-render is where `RecommendationsTab.jsx:167` executes. If it blocks (or crashes) the main thread, the microtask queue — and the fetch — never gets a turn. **This is exactly why the Network tab shows nothing.**

---

## 11. Evidence Table

| Claim | Evidence |
|---|---|
| `toDataURL` runs during render, every render | `RecommendationsTab.jsx:167` (inside JSX `src={}`) |
| It re-encodes full-resolution canvases, not thumbnails | `previews[scheme.id]` is the canvas from `renderSchemePreview` at full `width×height`; displayed at 112 px (`RecommendationsTab.jsx:169`) |
| `pending` dispatch precedes the `mutationFn` | `mutation.js` `execute()`: `dispatch({type:"pending"})` → `await onMutate?.(...)` → `await retryer.start()` |
| `mutationFn` (fetch) is deferred behind an `await` | same, step B |
| React flushes the discrete-event render before microtasks | React 18 synchronous flush for discrete input events |
| The crash occurs before `fetch` | `api.js:136-137`; `fetch` at `api.js:14` is the mutation body and is never observed |
| Preview canvases retained at full resolution (memory pressure) | `RecommendationsTab.jsx:54,75`; audit §7 (46–77 MB for 6–10 schemes) |
| Per-render cost is the top ranked hotspot | `AI_SCHEMES_AUDIT.md` §12 #1, §16 #2 |
| Preview compositing also wrong (secondary defect) | `renderSchemePreview.js:37` (`putImageData` overwrites) |

---

## 12. Contributing Factors

1. **Preview canvases kept at full canvas resolution** (1600×1200) while displayed at ~112 px tall (`RecommendationsTab.jsx:167,169`) — every encode is a full-res encode.
2. **No memoization/caching of the encoded data URL** — the same full-res PNG is re-encoded on every render of the tab, so any re-render (isPending, apply, save, parent churn) pays the full cost.
3. **Effect re-runs the whole LAB pipeline on every `schemes` refetch** (`RecommendationsTab.jsx:66-79`) — concurrent `Promise.all` of up to `6×5=30` full-image passes amplifies heap/CPU after a successful generation (secondary, post-fetch).
4. **No error boundary around the workspace** — a render-time crash blanks the whole SPA rather than failing one card.
5. **Preview path has no mask cache** (`renderSchemePreview.js:31`) — each scheme re-downloads/decode/upscales the same mask PNGs (memory/CPU amplifier; audit §9).

---

## 13. Repair vs Removal — Recommendation: **REPAIR**

The architecture is **not** unsalvageable; in fact it is sound:

- The server produces **catalog-only** schemes (no invented colors) — a business requirement (`RecommendationsTab.jsx:21-24`).
- The browser renderer (`applyPaintColor`) is the single paint engine used consistently across stage, previews, and export (`colorEngine.js`, audit §1).
- The crash is **one localized render-time hotspot** (`RecommendationsTab.jsx:167`), not a design flaw in the generate/apply pipeline.

Removal would eliminate a core selling feature over a fixable, single-statement defect. **Repair is mandatory; removal is not justified.**

---

## 14. Repair Scope (minimal, non-redesign)

The incident fix is a single-point change at the crashing statement:

1. **P0 — Stop re-encoding during render.** Cache the encoded data URL per scheme id (recompute only when the scheme's preview canvas actually changes), e.g. a `useMemo`/state map keyed by scheme id, so the render at `RecommendationsTab.jsx:167` becomes an O(1) lookup instead of a full-res PNG encode. This removes the block that precedes the fetch and restores normal mutation timing.
2. **P0 — Render previews at display resolution.** Downscale the preview canvas to ~256 px max edge when it is produced (`renderSchemePreview.js`, mirroring the existing `canvasToThumbnailBlob` logic at `:45-54`). Cuts each preview backing store ~30× (7.68 MB → ~0.25 MB), making even an un-cached render cheap. This is a display-only change; the card is 112 px tall.
3. **P1 (hardening, same statement)** — Fix the preview compositing defect (`renderSchemePreview.js:37`, `putImageData` overwrites all prior surfaces) so the preview matches the stage; otherwise the expensive work produces a wrong image.

These are behavior-preserving except for the intended correctness fix in (3). No new architecture, no worker offload, no server changes are required for the incident.

---

## 15. Verification Plan

1. Reproduce pre-fix: analyze asset → generate once → click Generate again → confirm freeze and empty Network tab.
2. Apply P0 fix (1): click Generate again → confirm `POST .../ai/recommendations` appears immediately and the button flips to "Generating schemes…" without a stall.
3. Apply P0 fix (2): confirm preview cards render identically at 112 px; confirm DevTools Memory shows ~30× less preview footprint.
4. Regression: Apply scheme, Save as concept, switch assets, regenerate — verify no `toDataURL` in any render path and no jank.
5. Watch DevTools Network for the second click's request specifically (the incident's defining symptom).

---

## 16. Lessons Learned / Prevention

- **Never run `toDataURL`/`toBlob` synchronously inside JSX render** — rendering must be side-effect free and cheap. Encoded artifacts belong in memoized state keyed by their source canvas.
- **Be aware of React 18 discrete-event flush vs. microtask ordering** — a blocking render before a deferred `mutationFn` produces "freeze with no request," which is easy to misattribute to the backend. When a click that should hit the network shows nothing in DevTools, the crash is in the render triggered by the mutation's `pending` state.
- **Store display-resolution data, render at display resolution** — previews were 69× larger than needed (7.68 MB vs. ~0.11 MB at 112 px height).
- **Add an error boundary** around the workspace so any future render-time failure degrades a card, not the whole SPA.

---

**Report complete.** All claims cite the current code and the installed `@tanstack/query-core@5.101.4` library source. No code was modified.
