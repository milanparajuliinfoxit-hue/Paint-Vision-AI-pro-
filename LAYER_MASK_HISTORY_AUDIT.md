# Layer Mask Versioning, History & Undo/Redo — Read-Only Audit

**Date:** 2026-08-10
**Type:** Read-only forensic audit. No application source code was modified.
**Scope:** Layer mask persistence, project history log, undo/redo, file lifecycle, cleaned-image lifecycle, production safety, as they exist today.

---

## A. Current architecture

```
Frontend                                  Backend                        Storage/DB
--------                                  -------                        ----------
Paint tool (brush/lasso/rect/...)
   |
   v
useHistoryCommand.js                      layers.routes.js
  commit() / commitMaskEdit() /           POST /assets/:assetId/layers
  commitCreate() / commitDelete()  --->   PATCH /api/layers/:id     ---> layers.controller.js
   |                                      DELETE /api/layers/:id         (createLayer/updateLayer/
   |  (also appends to history log)       POST /api/layers/:id/restore    deleteLayer/restoreLayer)
   v                                                                          |
useHistoryEntries.js                      history.routes.js                  v
  POST /projects/:id/history      --->    history.controller.js  --->   layers.model.js  ---> `layers` table
                                                                              |                (mask_path column)
visualizerStore.js (Zustand)                                                 v
  undoStack[], undoPointer                                              storage.service.js
  (local, in-memory; hydrated from                                      saveBuffer() ---> uploads/<assetId>/masks/
   server history + project.undo_pointer                                                   layer_<Date.now()>.png
   on load)
```

Files traced (all citations below are `file:line`):

- `backend/src/controllers/layers.controller.js`
- `backend/src/services/layers.model.js`
- `backend/src/routes/layers.routes.js`, `backend/src/routes/assetLayers.routes.js`
- `backend/src/services/storage.service.js`
- `backend/src/services/history.model.js`, `backend/src/controllers/history.controller.js`
- `backend/src/services/projects.model.js`
- `backend/src/controllers/assets.controller.js`, `backend/src/services/assets.model.js`
- `backend/src/sql/schema.sql`
- `frontend/src/features/visualizer/hooks/useHistoryCommand.js`
- `frontend/src/features/visualizer/hooks/useLayers.js`
- `frontend/src/features/visualizer/store/visualizerStore.js`
- `frontend/src/shared/lib/api.js`

**On the literal event name `paint.stroke.persist.started`:** grepped `frontend/src` and `backend/src` (excluding `node_modules`) for `paint.stroke`, `stroke.persist`, and `persist.started` — **zero matches**. This exact event name does not exist anywhere in the codebase. The real code path for a brush-stroke persist is `useHistoryCommand.js`'s `commitMaskEdit()` (line 126), which calls `useUpdateLayer`'s mutation (`useLayers.js:36`) against `PATCH /api/layers/:id` with a multipart mask file. The rest of this audit traces that real path; the report does not assume the named event exists.

---

## B. Mask lifecycle

**Filename generation** — `backend/src/controllers/layers.controller.js:27` (create) and `:89` (update):
```js
maskPath = await storage.saveBuffer(relativeDir, `layer_${Date.now()}.png`, req.file.buffer);
```
Both the create path and the update path generate the filename as `layer_<Date.now()>.png` — a **new file every time**, never a fixed/overwritten name. `storage.service.js:37`'s `saveBuffer` is a plain `fsp.writeFile` to that new path; it never touches or deletes any prior file.

**Answers to the six questions asked:**

1. **Is a new mask file generated for every stroke?** Yes — confirmed at `layers.controller.js:89` (`updateLayer`, the path a brush-stroke persist takes). Every PATCH that includes a file gets its own `layer_<timestamp>.png`.
2. **Is the previous mask file deleted?** No. `storage.service.js` exports a `deleteFile()` function (line 57), but a full-repo grep for `deleteFile` shows it is **never called anywhere outside its own definition/export in `storage.service.js`** — dead code. Nothing in the layer-update path calls it.
3. **Is this intentional?** Yes, explicitly. `layers.model.js:106-108`'s comment: *"Soft delete: keeps the row (and its on-disk mask file, untouched) so a later undo can restore it exactly instead of recreating a new row"*, and `useHistoryCommand.js:122-125`: *"A brush stroke re-uploads the mask as a brand-new file (storage never overwrites), so the old mask_path is still a valid file on disk — undoing a mask edit is just pointing mask_path back at it, no re-upload needed."* This is a deliberate design choice, not an oversight.
4. **Can repeated brush strokes create orphaned files?** Yes — confirmed both by code and by real data in the local dev database (see the layer-563 case study below). Every stroke's *previous* mask file becomes unreferenced by the *live* `layers.mask_path` row the moment a new stroke commits, and stays on disk permanently, retained only for the possibility of an undo.
5. **Does disk/storage usage grow indefinitely?** Yes, monotonically, under normal use. There is no cleanup mechanism anywhere in the codebase for old mask-file versions (see §E). `backend/src/scripts/reconcileUploads.js` exists but only reconciles orphaned *asset folders* after a DB reinit — it does not touch individual mask-file versions inside a live asset's `masks/` folder.
6. **Is this safe for production?** Partially — see §G/§H. The core mechanism (never delete, because undo may need it) is sound and intentional. What's missing is any bound on it: no version cap, no age-based reclaim, no reclaim even for genuinely unreachable branches (see the "orphaned branch" defect in §G). For a real dealer workload (repeated brush strokes across many photos over months), this is an unbounded-growth liability, not an immediate crash risk.

### Case study: real layer id 563 in the local dev database

The user's example (`layer_1786347871735.png` → `layer_1786347872224.png`) is **not hypothetical** — it is a real row. Queried directly:

```
layers WHERE id=563:
  asset_id: 91b2e6f5-c93f-4845-a6dd-d275462f8aa5
  mask_path: uploads/91b2e6f5.../masks/layer_1786347871735.png   <- currently live
  created_via: brush
  deleted_at: 2026-08-10 13:32:03.703   (soft-deleted)

history_entries WHERE layerId=563 (project_id 227):
  id 1388  mask-created   before=null                             after={layerId:563, createdVia:"brush"}
  id 1389  mask-edited    before={maskPath:...1735.png}            after={maskPath:...2224.png}
  id 1390  mask-edited    before={maskPath:...1735.png}   <- same "before" as 1389, not 2224
                                                            after={maskPath:...2351.png}
```
Both `layer_1786347871735.png` and `layer_1786347872224.png` are confirmed still present on disk (`ls` of the `masks/` folder). The live `mask_path` is back to the *first* file (`...1735.png`), and entry 1390's `before` restates that same first file rather than chaining from entry 1389's `after` (`...2224.png`) — i.e. the edit that produced `...2224.png` was superseded/abandoned, not built upon. This is the concrete real-world evidence behind the defect described in §G.1.

---

## C. History lifecycle

Table: `history_entries` (`schema.sql:139-147`):
```sql
id, project_id, action, before_state JSON, after_state JSON, created_at
```
That is the **entire** column set. Verified against the user's assumed field list:

| Assumed field | Actually a column? | Actually present at all? |
|---|---|---|
| `layerId` | No | Yes, but only inside the `before_state`/`after_state` JSON blob (`useHistoryCommand.js:109-110`), not a real column, and **not foreign-keyed to `layers.id`** — no `fk_history_layer` constraint exists in `schema.sql`. |
| `maskPath` / `previousMaskPath` | No | Yes, inside the JSON blob, only for `mask-edited` actions (`commitMaskEdit`, `useHistoryCommand.js:128`) |
| `createdVia` | No | Yes, inside the JSON blob, only for `mask-created` actions (`commitCreate`, `useHistoryCommand.js:135`) |
| `color`, `opacity`, `visibility`, `order` | No | Yes, inside the JSON blob, only when that specific field is the one being patched (`commit()`'s generic `before`/`after`, `useHistoryCommand.js:117-120`) — a color-change entry's JSON does not also carry opacity/visibility/etc. unless those changed in the same patch |

`history_entries` has **no schema-level structure per action type** — it is a generic `(action, before_state, after_state)` triple, and what's inside the JSON is entirely up to whichever `commit*` function wrote it (`useHistoryCommand.js:106-155`). This is a reasonable command-pattern design (store what's needed to invert *this* action, not a fixed universal shape) but means the table cannot be queried/validated at the DB level for "does this entry have a maskPath" — that's an application-level convention only, and the actual `ACTION_TYPE` map (`useHistoryCommand.js:27-39`) is the single source of truth for which action produces which shape.

**The log is genuinely append-only.** `history.model.js:3-15`'s `appendEntry` only ever `INSERT`s; there is no `UPDATE`/`DELETE` anywhere in `history.model.js` or `history.controller.js`. Nothing ever marks an entry superseded, abandoned, or prunes it — confirmed by the layer-563 case study above, where an abandoned branch (`entry 1389`) still exists in the table.

---

## D. Undo/redo lifecycle

`project.undo_pointer` (`schema.sql:81`, `INT NOT NULL DEFAULT -1`) is a **0-based index into the client's locally-reconstructed `undoStack` array**, not a history-row id and not a revision number. This is stated explicitly in the schema comment (`schema.sql:73-80`) and matches the actual code:

- `visualizerStore.js:62-63`: `undoStack: []`, `undoPointer: -1 // index of the last applied command; -1 = nothing applied`.
- `visualizerStore.js:107-112` (`pushCommand`): every new command does `undoStack: [...state.undoStack.slice(0, state.undoPointer + 1), command], undoPointer: state.undoPointer + 1` — a classic command-pattern stack: pushing after an undo **discards the in-memory redo tail** (but, per §C, does *not* delete the now-orphaned entries from the server's `history_entries` log — see §G.1).
- `visualizerStore.js:104-105` (`hydrateHistory`): on load, rebuilds `undoStack` from *every* fetched `history_entries` row (filtered only to recognized action types — `useHistoryCommand.js:70`), in `created_at ASC, id ASC` order (`history.model.js:19`), and sets `undoPointer` from `project.undo_pointer` (clamped to the list length). This is a **flat, linear replay of the entire append-only log** — it does not know about, and cannot reconstruct, which entries were part of an abandoned branch versus the branch actually kept. See §G.1.
- `useHistoryCommand.js:177-187` (`undo`/`redo`): `undo()` calls `applyCommand(undoStack[undoPointer], 'before')` then unconditionally `moveUndoPointer(-1)`; `redo()` is the mirror. **The pointer move is not gated on the mutation succeeding** — `applyCommand`'s `updateLayer.mutate(...)`/`removeLayer.mutate(...)`/`restoreLayer.mutate(...)` calls are fire-and-forget (`.mutate`, not awaited before `moveUndoPointer` runs). See §H.1.
- Pointer persistence: `useHistoryCommand.js:96-100`, debounced 400ms, writes the local pointer back to `project.undo_pointer` via `PATCH /api/projects/:id` — skipped when the pointer value came *from* hydration itself (comment at line 90-95), to avoid a lost-race write-back.

**Walkthrough — create → stroke → stroke → undo → undo → redo → redo**, reasoned from the code (not live-driven through the browser in this audit):

1. **Create**: layer row exists server-side already (creation is a separate `POST`); `commitCreate()` (`useHistoryCommand.js:134-137`) appends a `mask-created` history entry and pushes `{type:'create', layerId}`. `undoStack=[create]`, pointer `0`.
2. **Stroke 1**: `commitMaskEdit()` uploads a new mask file, appends a `mask-edited` entry with `before={maskPath: <prior>}`, `after={maskPath: <new file A>}`, pushes a `patch` command. `undoStack=[create, patchA]`, pointer `1`.
3. **Stroke 2**: same, new file B. `undoStack=[create, patchA, patchB]`, pointer `2`.
4. **Undo**: `applyCommand(patchB, 'before')` → `PATCH /api/layers/:id {maskPath: <file A>}` — a plain JSON patch, no re-upload, exactly as the code comment promises. Pointer → `1`.
5. **Undo again**: `applyCommand(patchA, 'before')` → mask_path back to whatever preceded stroke 1. Pointer → `0`.
6. **Redo**: `applyCommand(patchA, 'after')` → mask_path → file A. Pointer → `1`.
7. **Redo again**: `applyCommand(patchB, 'after')` → mask_path → file B. Pointer → `2`.

**Within one continuous browser session, with no reload in between, this restores the exact previous mask state at every step** — confirmed by the code: every `before`/`after` in a `patch` command is a real, still-on-disk file path (per §B, files are never deleted), and `applyCommand`'s dispatch (`useHistoryCommand.js:160-175`) correctly maps `type` → inversion for `patch`/`create`/`delete`/`bulk-delete`.

**The gap is across a reload** (or a fresh hydration), combined with an undo-then-repaint branch — see §G.1. The step-by-step walkthrough above is sound *only* while `undoStack` is the in-memory array built by `pushCommand`'s truncating pushes; `hydrateHistory`'s reconstruction after a reload uses a different, non-truncating method (append-only replay) and can disagree with what the in-memory stack looked like before the reload.

---

## E. File lifecycle

| Event | What happens to mask files | Evidence |
|---|---|---|
| Create | New file written, DB row created pointing at it | `layers.controller.js:24-28` |
| Update (stroke) | New file written, DB row repointed; **old file left in place** | `layers.controller.js:87-96`, `layers.model.js:83-104` |
| Undo/redo of a patch | No file I/O — just a JSON `PATCH {maskPath}` repointing the DB column back to an already-existing file | `useHistoryCommand.js:126-129`, `layers.model.js:97` (`FIELD_MAP` includes `maskPath`, patch has no `req.file` here so `layers.controller.js:87`'s `if (req.file)` branch is skipped) |
| Delete layer | **Soft delete only** — `deleted_at` set, row and file both untouched | `layers.model.js:110-112`, comment explicitly explains why (undo of a delete must restore the exact same row/file) |
| Restore layer (undo a delete / redo a create) | `deleted_at` cleared; no file I/O since the file was never touched | `layers.model.js:114-117` |
| Delete asset | **Both** of an asset's two real on-disk locations recursively removed: `<assetId>/` (original/cleaned photo + AI masks) and `uploads/<assetId>/` (layer masks) — confirmed no orphan is left behind by this path | `assets.controller.js:144-155`, `storage.service.js:98-101` (`removeTree`) |
| Delete project | Transactional at the DB layer (`assets` rows deleted, then the `projects` row, one transaction, rollback on error); disk cleanup is explicitly the route's job per the same pattern as asset delete (comment, `projects.model.js:96-102`) | `projects.model.js:103-117` |

**Orphan files, confirmed:**
1. Every superseded mask-file version becomes an orphan (unreferenced by the live `mask_path`) the moment a newer stroke commits — retained deliberately for undo (§B.3), not itself a bug.
2. **A discarded redo branch's mask file is permanently orphaned with no code path that ever reclaims it**, even though the *history_entries row* describing it survives forever in the DB (see §G.1's real example — layer 563's `...2224.png`).

**Race conditions:** not exercised live in this audit, reasoned from code only (H, not G):
- Two concurrent PATCHes to the same layer (e.g. a stray double-fire) are not serialized against each other beyond whatever MySQL's row-level update ordering gives for free; the app has no per-layer lock. Combined with §G.2 (no `updatedAt` sent), this means a losing concurrent write is silently applied, not rejected.
- A save (`layers.controller.js:89`, writes file then updates DB) racing an asset delete (`assets.controller.js:135` deletes the DB rows, `:153-155` `removeTree`s the folder) could in principle write a new mask file into a directory that's about to be (or just was) recursively removed — `removeTree`'s `force: true` (`storage.service.js:100`) makes the delete itself tolerant of the directory not existing, but a save landing *after* the tree removal would silently write into a now-orphaned folder that nothing will ever clean up (the asset row is already gone, so `reconcileUploads.js` and the normal delete path won't find it again — it would need `original.jpg` to exist to be picked up as a re-linkable orphan by that script, and a masks-only leftover folder won't have one). No evidence this has actually happened; flagged as a reasoned risk only.

---

## F. Cleaned-image lifecycle

Real column names (`schema.sql:91-105`, `assets` table): **`original_path`, `cleaned_path`** — not `cover_original_path`/`cover_cleaned_path`. (Those latter two names *do* exist, but on `projects`, not `assets` — `frontend/src/features/projects/ProjectCover.jsx:4,10` reads `project.cover_original_path`/`project.cover_cleaned_path` for the dashboard's project-card thumbnail, which mirrors whichever asset is the project's designated cover. Two different, correctly-named things.)

1. **Where created:** `cleaned_path` is set exactly once, by `assets.controller.js`'s `requestCleanup` (lines 66-114), via `assetsModel.updateAssetStatus(asset.id, { status: 'cleaned', cleanedPath })` (line 106).
2. **What operation produces `cleaned.jpg`:** a real, dealer-triggered, hosted-AI call — `aiProxy.callCleanup(imageBuffer, maskBuffer)` (line 87), the same hosted FLUX.2-edit proxy this project's AI work uses elsewhere. Not legacy, not a placeholder. The mask fed to it is either an explicit dealer-drawn mask (`req.file`, wins outright — line 74-76) or, if none was drawn, a mask derived from house-understanding's detected removable objects (`objectRemovalMask.buildDefaultRemovalMask`, line 84). Before the result is persisted, `removalQuality.checkHouseDamage` (line 92) can reject it outright if it altered the house itself too much — the original is retained and nothing is written to disk in that case (lines 93-99).
3. **AI-generated, not manual/legacy** — confirmed above.
4. **Used by the frontend:** yes, extensively, all reading the raw `cleaned_path` field directly (no camelCase remapping on read, only on patch payloads):
   - `VisualizerWorkspace.jsx:77-79,675` — the Original/Cleaned/Painted compare toggle and the before/after slider.
   - `AssetsTab.jsx:82,162,201,268,276` — the "Cleaned" gallery section, and rename/delete dialog labeling.
   - `ProjectCover.jsx:4,10` — dashboard project-card thumbnail (via the project-level `cover_cleaned_path`, sourced from whichever asset is the cover).
5. **Can the existing architecture safely support the future hosted AI cleanup pipeline being built in this project?** Yes, structurally, with one asymmetry worth naming: unlike layer masks, `cleaned.jpg` uses a **fixed filename, not a timestamped one** (`assets.controller.js:104`: `storage.saveBuffer(relativeDir, 'cleaned.jpg', cleanedBuffer)`), and `cleaned_path` is a single column updated via `COALESCE` (`assets.model.js:34`) — re-running cleanup **overwrites** the previous cleaned image in place, with no history/undo entry for the operation at all (cleanup isn't part of the `history_entries`/`undoStack` system — it's asset-level state, not a layer command). This is consistent with cleanup being an explicit, occasional, whole-photo operation rather than a rapid-fire per-stroke one, and is not a defect against how the feature is actually used today — but it does mean a dealer who cleans, dislikes the result, and re-cleans cannot get the first cleaned version back. Out of scope to change here; noted for awareness only, per the instruction not to extend this architecture in this pass.

---

## G. Confirmed defects

Both items below are backed by direct code citations; item 1 additionally has a real, reproducible example already sitting in the local dev database (§B's case study).

### G.1 — Redo can resurrect an abandoned mask-edit branch after a reload

**STATUS: FIXED (2026-08-10).** `history_entries` gained a nullable `superseded_at` column; the client now tells the server which entries its local undo-stack truncation just discarded (via `supersedeIds` on the same append call that records the new branch), marked in the same transaction. `hydrateHistory` and `HistoryTab.jsx` both now exclude superseded entries. Pre-existing ambiguous history (e.g. layer 563 itself, entries 1389/1390) is **not** retroactively repaired — only new branching from this fix forward is protected; see the implementation report for full detail. All fields below describe the defect as it existed before this fix, kept for record.

**Mechanism:**
- The server's `history_entries` log is strictly append-only (§C) — nothing ever marks a row as belonging to a discarded branch.
- The *live* session's `undoStack` correctly discards a redo branch in memory when a new command is pushed after an undo (`visualizerStore.js:109`, `slice(0, pointer+1)`), but this pruning is **never mirrored to the server** — the abandoned entries stay in `history_entries` forever.
- `hydrateHistory` (`useHistoryCommand.js:65-88`), run on every fresh load/hydration, rebuilds `undoStack` as a **flat, unpruned map over every fetched `history_entries` row**, in creation order.

**Consequence:** if a user undoes a mask edit, paints something different (creating a new branch), and then reloads the page (or the hydration re-runs for any reason — e.g. switching assets and back), the reconstructed `undoStack` contains *both* the abandoned edit and the real one as sequential entries, not as a single branch point. Redoing far enough past the reload's restored pointer position can re-apply the **abandoned** `mask-edited` entry's `after` state — silently repainting a mask version the user explicitly moved away from — rather than the version they actually kept.

**Real evidence:** layer id `563` (project 227) has exactly this shape in the live dev database: two `mask-edited` history entries (`id 1389`, `id 1390`) with the *same* `before.maskPath`, meaning the edit recorded in `1389` (→ `...2224.png`) was abandoned in favor of the edit in `1390` (→ `...2351.png`), yet `1389` remains a fully live, replayable row in `history_entries`. Both mask files are still present on disk (per §B).

### G.2 — No layer PATCH in the app ever sends `updatedAt`, so the server's optimistic-concurrency check is never actually exercised

`layers.model.js:87-95`'s `updateLayer` has a real conflict check (`if (expectedUpdatedAt) { ...409 on mismatch... }`), and the client function `layers.update(layerId, patch, updatedAt, maskBlob)` (`api.js:142-147`) is fully wired to send it. But `useUpdateLayer` (`useLayers.js:36`) is instantiated **exactly once** in the whole frontend (`useHistoryCommand.js:42`), and all three of its call sites — `commit()` (`:118`), `commitMaskEdit()` (`:127`), and `applyCommand()` (`:163`, used by undo/redo/jumpTo) — omit `updatedAt` from the `.mutate(...)` payload. `expectedUpdatedAt` is therefore always falsy and the conflict check never runs, for any layer mutation the app makes, ever. This is a preexisting, previously-documented gap (visible in this repo's own earlier audit trail, `analysisreport.md`'s F-finding on "Optimistic-concurrency UI gap"); this audit reconfirms it with fresh citations rather than discovering it new, and flags it here specifically because it is directly relevant to undo/redo safety under concurrent access (§H.2).

---

## H. Potential risks (reasoned from code, not reproduced live)

1. **Undo/redo pointer moves regardless of mutation success.** `undo()`/`redo()` (`useHistoryCommand.js:177-187`) call `applyCommand(...)` (which is a fire-and-forget `.mutate`, not awaited) and then unconditionally call `moveUndoPointer(...)`. If the underlying PATCH/DELETE/restore 404s or fails (e.g. because the layer's owning asset was deleted out from under a stale history entry — see below), the local pointer still advances as if it succeeded, silently desyncing the visible undo position from server reality. `useDeleteLayer`'s `onError` (`useLayers.js:66-72`) at least restores the optimistic UI and logs `layer.delete.failed`; `useUpdateLayer`'s `onError` (`useLayers.js:44-46`) does the equivalent for patches. Neither one un-does the pointer move.
2. **Deleting an asset can strand history entries that still reference its layers.** `layers` cascades on `assets` delete (`fk_layer_asset ... ON DELETE CASCADE`, `schema.sql:128`), but `history_entries` has no FK to `layers` at all — only a `layerId` inside a JSON blob. A project's history log can therefore end up referencing layer ids that no longer exist (because their asset/photo was deleted), and undoing/redoing past that point would hit a 404 for that entry's `applyCommand` call — degrading per risk #1 above (pointer moves anyway) rather than surfacing clearly to the user.
3. **A file write that succeeds followed by a DB update that fails** (rare — e.g. a dropped DB connection between `layers.controller.js:89` and `layers.model.js:98`'s `pool.query`) leaves a new, real, unreferenced mask file on disk with no DB row pointing to it and no error path that cleans it up. Low likelihood, benign impact (an extra file, not a correctness issue), no evidence this has occurred.
4. **No automated test coverage exists for this system.** A repo-wide search found no test file for `layers.model.js`, `history.model.js`, or `useHistoryCommand.js`'s undo/redo/hydrate logic — only `layerCacheUtils.test.js` (a narrower cache-merge helper) touches this area at all. This doesn't itself cause a defect, but it means none of G.1/G.2/H.1/H.2 above would be caught by `npm test` today, and any future change here has no regression net specific to undo/redo correctness.

---

## I. Recommended minimal fixes (proposals only — none implemented)

**For G.1 (abandoned-branch resurrection):** the smallest safe fix is server-side, additive, and touches nothing else: add a nullable `superseded_at` (or `branch_id`) marker to `history_entries`, set it when `pushCommand`'s client-side truncation would have discarded an entry — i.e. have the client tell the server "these entry ids are no longer on the live branch" the next time it pushes past an undo, via a small new endpoint or an extra field on the existing `POST /projects/:id/history` call. `hydrateHistory`'s query would then filter `WHERE superseded_at IS NULL`. This is additive (new nullable column, no change to any existing row's meaning), doesn't touch the mask-file retention model at all, and doesn't change undo/redo behavior within a single unreloaded session (which is already correct per §D). Sizing note: this is a real schema change and a real behavior change to the history log, so per this project's own governing rules it should be proposed and approved as its own small phase, not folded into an unrelated change.

**For G.2 (optimistic concurrency never exercised):** the smallest safe fix is passing the current layer's `updated_at` through the three `useUpdateLayer.mutate(...)` call sites that already have the layer object in scope (`commit`, `commitMaskEdit`, `applyCommand`) — no backend change needed at all, since `layers.model.js`'s check already exists and already works; it's simply never invoked. This is low-risk because the check is opt-in server-side (only runs `if (expectedUpdatedAt)`) — turning it on could not silently break anything that isn't already a genuine conflict, though it would need a UX decision for what happens on a 409 (currently unhandled by any caller) before shipping.

Neither fix should be applied speculatively — both are sized here only as answers to "what would the smallest safe correction look like," per the audit brief. Confirm intent before implementing either.

---

## J. No-change areas

The following were traced in full and found to be working exactly as designed. **Do not modify:**

- The core mask-file-never-overwritten model (§B) — this is the entire mechanism that makes intra-session undo/redo of a mask edit instant (no re-upload) and correct. It is the right design for what it does.
- The soft-delete model for layers (`deleted_at`, §E) — exists specifically so undo of a delete restores the exact same row/id, and does so correctly.
- `deleteAsset`'s and `deleteProject`'s file/DB cleanup (§E) — both correctly remove every real on-disk location an asset/project owns, including the easy-to-miss nested `uploads/<assetId>/` masks wrapper; `deleteProject` is properly transactional with rollback.
- Intra-session undo/redo/jumpTo command dispatch (`applyCommand`, `useHistoryCommand.js:160-175`) — correctly inverts all four command types (`patch`/`create`/`delete`/`bulk-delete`) and, within one continuous session with no reload, restores exact prior mask state at every step (§D's walkthrough).
- The idempotent AI-surface layer upsert (`upsertAiLayer`, `layers.model.js:18-39`) — keyed correctly on `(ai_analysis_id, ai_surface_key)`, correctly revives a soft-deleted row rather than duplicating.
- The cleaned-image pipeline's real-AI-call + damage-check-before-persist flow (§F) — sound, and does not need to change to support the project's broader hosted-AI direction; it's already real, hosted, and validated before writing.

---

## K. Regression results

No code was changed in this audit. Baseline run to confirm the working tree's current state, unchanged:

- Backend (`cd backend && npm test`): **103/103 passing**
- Frontend (`cd frontend && npm test`): **41/41 passing**

---

## Closing assessment

The existing layer/mask/history/undo system is **sound enough to build AI-generated surface layers on top of without modification.** Its foundational design choices — mask files as immutable, timestamped, never-overwritten versions; soft-delete for layers; an append-only history log; a client-reconstructed undo stack seeded from that log plus a persisted pointer — are all real, working, and specifically already accommodate AI-originated layers today (`upsertAiLayer`'s idempotency key exists precisely for this). Nothing here needs to change, or should change, merely because AI-generated layers are being added; per §J, `ai-surface` layers already flow through the exact same `layers` table, same mask-file storage pattern, and same soft-delete/restore mechanics as hand-painted ones.

The one item worth resolving **before**, not necessarily instead of, further layering AI features on top is **G.1** — the abandoned-branch resurrection risk — specifically because AI-surface layers will make branching edit histories more common (apply a scheme, undo, apply a different scheme, reload) rather than less, which raises how often this exact shape can occur. G.2 (optimistic concurrency) is real but lower urgency: it's a preexisting, already-documented gap, not something newly introduced or worsened by AI layers specifically. Everything else in this report (H.1-H.4) is a reasoned risk, not a confirmed defect, and does not block proceeding.
