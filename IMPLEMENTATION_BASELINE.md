# IMPLEMENTATION BASELINE REPORT

**Date:** 2026-08-10  
**Branch:** `dev`  
**Scope:** Complete forensic re-audit of Paint Visualizer application  
**Purpose:** Establish baseline before AI-first product completion implementation

---

## EXECUTIVE SUMMARY

The Paint Visualizer is a well-architected React/Express application with a modular design, robust state management, and a functional AI provider registry. The system is **production-ready for catalog-based paint visualization** but has a **critical gap in house-understanding AI capabilities** due to lack of a production provider for exterior scene analysis.

**Key Findings:**
- ✅ **All baseline tests pass:** Backend 76/76, Frontend 41/41
- ✅ **Frontend builds successfully:** Production build completes
- ✅ **Core rendering pipeline functional:** LAB-based recoloring with lightness preservation
- ✅ **Paint recommendation functional:** Both rule-based and LLM-based options available
- ❌ **House-understanding disabled:** No production provider registered for exterior scene analysis
- ⚠️ **Security minimal:** Single API key authentication, no user auth
- ⚠️ **Autonomous pipeline non-functional:** Due to disabled house-understanding

---

## BASELINE METRICS

### Test Results
| Suite | Tests | Pass | Fail | Duration |
|-------|-------|------|------|----------|
| Backend | 76 | 76 | 0 | 1.8s |
| Frontend | 41 | 41 | 0 | 0.3s |
| **Total** | **117** | **117** | **0** | **2.1s** |

### Build Status
- ✅ Frontend production build: Success (12.87s)
- ⚠️ Backend build: No build script (not required for Node.js)
- ⚠️ Warning: Frontend bundle size 923KB (above 500KB threshold)

### Git Status
- **Current Branch:** `dev`
- **Status:** Clean (2 untracked files: analysisreport.md, image.png)
- **Recent Commits:** AI house understanding features merged in `feat/ai-house-understanding` branch

---

## BACKEND ARCHITECTURE

### Technology Stack
- **Runtime:** Node.js (Express framework)
- **Database:** MySQL (connection pool, 10 connections)
- **Storage:** Local disk (filesystem with path traversal protection)
- **Language:** JavaScript (no TypeScript)

### Route Structure
**Total Routes:** 30+ endpoints across 13 route files

| Category | Route File | Endpoints | Purpose |
|----------|------------|-----------|---------|
| Projects | projects.routes.js | 8 | Project CRUD, nested routes |
| Assets | assets.routes.js | 6 | Asset CRUD, cleanup, duplication |
| Layers | layers.routes.js | 3 | Layer CRUD, soft-delete, restore |
| AI | ai.routes.js | 6 | Analysis, recommendations, pipeline |
| Paints | paints.routes.js | 5 | Catalog CRUD |
| Import/Export | importExport.routes.js | 3 | Excel import/export |
| Concepts | concepts.routes.js | 2 | Saved concepts |
| Exports | exports.routes.js | 2 | Export jobs |
| History | history.routes.js | 2 | Undo/redo log |
| Meta | meta.routes.js | 1 | AI capability metadata |

### Controller Layer
**Total Controllers:** 8

All controllers follow consistent patterns:
- try/catch with next(err) for error handling
- Minimal business logic (delegated to services/models)
- Consistent JSON response structure
- File upload handling via Multer

### Service Layer
**Total Services:** 20+

**Key Services:**
- **Models:** projects, assets, layers, paints, aiJobs, concepts, exports, history
- **AI Services:** aiRegistry, aiPipeline, houseUnderstanding, paintRecommendation
- **AI Quality:** surfaceQuality, removalQuality, objectClassification
- **Infrastructure:** storage, logger, excelImport, paints.validation

### Database Schema
**Total Tables:** 11

| Table | Purpose | Relationships |
|-------|---------|---------------|
| paints | Paint catalog | - |
| import_log | Excel import audit | - |
| projects | Project metadata | → assets (SET NULL) |
| assets | Uploaded photos | → projects, ← layers (CASCADE), ← ai_jobs (CASCADE) |
| layers | Paint layers | → assets (CASCADE), → paints (SET NULL) |
| history_entries | Undo/redo log | → projects (CASCADE) |
| concepts | Saved concepts | → projects (CASCADE) |
| export_jobs | Export jobs | → projects (CASCADE) |
| ai_jobs | AI job audit | → assets (CASCADE), ← detected_surfaces (CASCADE), ← detected_objects (CASCADE) |
| detected_surfaces | Paintable surfaces | → ai_jobs (CASCADE), → assets (CASCADE) |
| detected_objects | Removable objects | → ai_jobs (CASCADE), → assets (CASCADE) |
| paint_recommendations | Generated schemes | → projects (CASCADE), → assets (CASCADE) |

**Schema Status:** ✅ Complete with proper constraints, indexes, and cascade behavior

---

## FRONTEND ARCHITECTURE

### Technology Stack
- **Framework:** React 18 with Vite
- **Rendering:** Konva.js (canvas-based)
- **State Management:** Zustand (ephemeral) + TanStack Query (server)
- **Persistence:** LocalStorage, IndexedDB (idb-keyval)
- **UI Components:** Radix UI primitives + custom components
- **Styling:** Tailwind CSS

### Route Structure
**Total Routes:** 5 main routes

```
/ → /dashboard (redirect)
/dashboard → DashboardPage
/projects → ProjectsListPage
/visualize → VisualizeRedirect (triggers project creation)
/projects/:projectId/visualize → VisualizerWorkspace (main editor)
/catalog → CatalogPage
```

### Component Architecture
**Feature Modules:**
- **catalog:** CatalogPage, PaintCard, useCatalogList, useFavorites
- **projects:** DashboardPage, ProjectsListPage, CreateProjectModal, useProjects
- **visualizer:** VisualizerWorkspace, CanvasStage, LayerNode, panels (SidePanel, Inspector, Toolbar, ExportPanel), tools (selection, paint, utility)

### State Management Distribution

| State Type | Storage | Ownership | Scope |
|------------|---------|-----------|-------|
| Editor ephemeral | Zustand | Client-side | Per session |
| Server data | React Query | Server | Per project/asset |
| UI preferences | LocalStorage | Client-side | Per browser |
| Draft state | IndexedDB | Client-side | Per project |
| History | Server + Zustand | Both | Per project |

### Rendering Pipeline
**Single Renderer:** `colorEngine.applyPaintColor` (LAB-based recoloring)

**Key Features:**
- Preserves lightness/shading/texture
- LUT-optimized sRGB→linear conversion
- RAF-coalesced recomputes
- Instant rendering via localMaskOverrides

**Algorithm:**
1. Convert to CIE LAB color space
2. Preserve lightness relationship
3. Pull a/b channels toward target paint color
4. Re-convert to RGB

### Tools Implementation
**Selection Tools:** rect, lasso, polygon, magic-wand, surface-pick
**Paint Tools:** brush (surface-aware), eraser (auto-delete)
**Utility Tools:** eyedropper, pan

**Special Features:**
- Surface-aware brush with region-growing algorithm
- House-aware Magic Wand with boundary detection
- LAB color distance matching
- Window-level mouseup (prevents stuck strokes)

---

## AI ARCHITECTURE

### Provider Registry
**Location:** `backend/src/services/ai/aiRegistry.service.js`

**Registered Providers:**
```javascript
const PROVIDERS = [catalogRecommendationProvider, hfSchemeProvider];
```

**NOT Registered:**
- `mockProvider` - Explicitly excluded (test fixture only)

### Capability Configuration

| Capability | Enabled | Provider | Provider Registered | Status |
|------------|---------|----------|---------------------|--------|
| house-understanding | ❌ DISABLED | None (null) | NO | **NO PRODUCTION PROVIDER** |
| paint-recommendation | ✅ ENABLED | catalog (default) | YES | **FULLY FUNCTIONAL** |

### Provider Analysis

#### catalogRecommendationProvider
- **ID:** `catalog`
- **Version:** `catalog-rules-v1`
- **Capability:** `paint-recommendation` only
- **Functionality:** Rule-based color theory applied to catalog paints
- **External API:** None (pure algorithmic)
- **Status:** ✅ **ACTIVE & FUNCTIONAL**

#### hfSchemeProvider
- **ID:** `hf-scheme`
- **Version:** `hf-llama-3.1-8b-instruct-v1`
- **Capability:** `paint-recommendation` only
- **Functionality:** Hosted LLM (Llama 3.1 8B) proposes HSL targets, resolved to catalog paints
- **External API:** Hugging Face (requires `HF_API_KEY`)
- **Status:** ✅ **REGISTERED & FUNCTIONAL** (requires API key)

#### mockProvider
- **ID:** `mock`
- **Version:** `mock-understanding-v1`
- **Capability:** `house-understanding` only
- **Functionality:** Jimp-based image heuristics (NOT real AI)
- **Status:** ⚠️ **NOT REGISTERED** - Test fixture only

### AI Pipeline Status
**Location:** `backend/src/services/ai/aiPipeline.service.js`

**Pipeline Stages:**
- `idle` - Analysis never started
- `understanding` - Analysis running or succeeded, no recommendation yet
- `schemes` - Recommendation running
- `ready` - Both succeeded
- `failed` - Either stage failed

**Concurrency Protection:**
- In-flight lock per asset (inFlightLock.service.js)
- Database constraint on duplicate running jobs (uq_ai_jobs_running)

### Supporting AI Services
- **inFlightLock.service.js:** Per-key concurrency guard ✅
- **surfaceQuality.service.js:** Surface quality scoring ✅
- **removalQuality.service.js:** Post-cleanup damage check ✅
- **objectRemovalMask.service.js:** Default removal mask from analysis ✅
- **objectClassification.js:** Object category classification ✅

---

## CONFIGURATION STATE

### Environment Variables

#### Server Configuration
```bash
PORT=4000
NODE_ENV=development
API_ACCESS_KEY=pv-local-dev-key-2026
CORS_ORIGIN=http://localhost:5173
```

#### Database Configuration
```bash
DB_HOST=localhost
DB_PORT=3306
DB_USER=paint_app
DB_PASSWORD=change-me
DB_NAME=paint_visualizer_pro
```

#### Storage Configuration
```bash
UPLOAD_ROOT=./uploads
MAX_UPLOAD_MB=25
```

#### AI Provider Configuration
```bash
AI_PROVIDER=huggingface
CLIPDROP_API_KEY=replace-with-real-key
CLIPDROP_CLEANUP_URL=https://clipdrop-api.co/cleanup/v1
```

#### Hugging Face Configuration
```bash
HF_API_KEY=REDACTED_HF_API_KEY
HF_MODEL=fal-ai/fal-ai/flux-2/klein/9b/edit
HF_API_URL=https://router.huggingface.co/fal-ai/fal-ai/flux-2/klein/9b/edit
HF_INPUT_MODE=json
HF_JSON_SHAPE=image_urls
HF_PROMPT=Extract and isolate the primary residential building...
HF_IMAGE_FIELD=image_urls
HF_MASK_FIELD=mask_file
HF_IMAGE_CONTENT_TYPE=application/octet-stream
```

#### AI Capability Configuration
```bash
AI_ANALYSIS_ENABLED=true                    # ⚠️ ENABLED in .env (dev) but disabled in .env.example
AI_RECOMMENDATION_ENABLED=true
AI_RECOMMENDATION_PROVIDER=catalog        # Default: catalog
AI_ANALYSIS_PROVIDER=                      # Empty - no provider configured
AI_SCHEME_MODEL=meta-llama/Llama-3.1-8B-Instruct
AI_SCHEME_MODEL_PROVIDER=novita
AI_ANALYSIS_MAX_DIM=640
AI_RECOMMENDATION_COUNT=6
AI_RECOMMENDATION_PRODUCT_LINES=
```

---

## SECURITY ASSESSMENT

### Authentication/Authorization
**Mechanism:** Simple shared API key via `x-api-key` header

**Applied to:** All `/api/*` routes

**Fallback:** If key not configured or is placeholder, allows all requests (dev mode)

**Special Route:** `/files/*` also accepts `?key=` query param for `<img>` tags

**Assessment:**
- ⚠️ **No user authentication** - Single-key shared access
- ⚠️ **No role-based access control** - All keys have full access
- ⚠️ **Query param acceptance** - API key in URL (logged in browser history)
- ✅ **Key validation** - Checks for placeholder value
- ✅ **Configurable** - Can be removed for private network deployment

### Security Middleware
- **helmet:** Applied with CORP policy override for cross-origin image loading
- **cors:** Configured with `CORS_ORIGIN` env var (default: `*`)
- **rateLimit:** Three rate limiters for different endpoint types
- **requestId:** UUID assignment for request correlation
- **errorHandler:** Generic error messages, no stack traces in responses

### Upload Validation
- **Two-layer validation:** Mimetype check + magic byte check
- **Supported formats:** JPEG, PNG, WEBP, GIF, .xlsx
- **Decompression bomb guard:** `MAX_IMAGE_DIMENSION = 8000`
- **Security:** Prevents renamed files, fake Content-Type, memory exhaustion

### Path Traversal Protection
- **Implementation:** `path.relative()` in storage.service.js
- **Guards:** Prevents `..` escape and sibling-prefix attacks

### HTTP Client Security
- **Timeout protection:** 30s default timeout
- **Size limits:** 25MB max for GET requests (SSRF protection)
- **Retry logic:** Backoff for 429/503/504 (max 2 retries)
- **Structured logging:** All provider calls logged with latency/status

### Security Gaps

**High Priority 🔴**
1. No user authentication - Single shared API key
2. API key in URL - `/files/*` accepts `?key=` query parameter
3. No audit logging - No record of who accessed what

**Medium Priority 🟡**
1. No rate limiting per user - Global limits only
2. No file encryption - Files stored in plain
3. No backup mechanism - Data loss risk

**Low Priority 🟢**
1. CORS origin default - `*` allows any origin (configurable)
2. No input sanitization - Relies on parameterized queries (adequate)

---

## STORAGE ARCHITECTURE

### Implementation
**Technology:** Local disk storage via `fs/promises`

### Directory Structure
```
UPLOAD_ROOT/
  ├── <asset-id>/              # Original + cleaned photos, AI masks
  │   ├── original.jpg
  │   ├── cleaned.jpg
  │   └── ai/
  │       ├── <surface-key>.png
  │       └── <object-key>.png
  ├── uploads/
  │   ├── <asset-id>/          # Layer masks (historical inconsistency)
  │   │   └── masks/
  │   │       └── layer_<timestamp>.png
  │   └── projects/
  │       └── <project-id>/
  │           ├── concepts/
  │           │   └── concept_<timestamp>.png
  │           └── exports/
  │               └── export_<id>.<ext>
```

### Security Considerations
- ✅ Path traversal protection via `path.relative()`
- ✅ Only server-known IDs used (no user-supplied paths)
- ✅ Best-effort cleanup on delete
- ⚠️ No file encryption
- ⚠️ No deduplication
- ⚠️ No backup/sync mechanism

### Historical Inconsistency
- Asset photos use `<asset-id>/` directly
- Layer masks nest under `uploads/<asset-id>/`
- This is documented but not ideal; `removeTree` handles both on cleanup

---

## WHAT EXISTS AND WORKS ✅

### Backend
1. Full CRUD operations for projects, assets, layers, paints, concepts, exports, history
2. Excel import/export for paint catalog with validation and transaction support
3. AI cleanup/inpainting via Clipdrop or Hugging Face providers
4. Paint recommendation via catalog provider (rule-based, fully functional)
5. Paint recommendation via hf-scheme provider (LLM-based, requires HF_API_KEY)
6. Layer management with soft-delete for undo/redo support
7. Optimistic concurrency on projects and layers
8. Autonomous AI pipeline (analysis → recommendations) - currently non-functional due to analysis disabled
9. Structured logging to console and files
10. Rate limiting for expensive operations
11. File upload validation with magic byte checks and decompression bomb guards
12. Path traversal protection in storage service
13. Database constraints and cascade deletes

### Frontend
1. Complete project-scoped routing with guards
2. Full catalog CRUD, search, filters, hex similarity, favorites
3. Project dashboard with statistics and recent projects
4. Konva-based rendering with viewport management
5. All selection tools (rect, lasso, polygon, magic-wand, surface-pick)
6. Paint tools (surface-aware brush, eraser with auto-delete)
7. LAB-based recoloring with lightness preservation
8. Full mask operations (rasterization, merging, feathering)
9. Layer management (visibility, lock, order, delete, opacity)
10. Command pattern undo/redo with persistence
11. AI surface detection and quality scoring
12. AI scheme generation with preview rendering
13. PNG and side-by-side JPG export
14. Zustand + React Query state separation
15. LocalStorage, IndexedDB drafts, server history
16. Responsive design (3-pane, sheet, mobile read-only)
17. Keyboard accessibility (tool shortcuts, undo/redo, grid navigation)
18. Performance optimizations (instant rendering, caching, RAF coalescing)

---

## WHAT IS DISABLED/BROKEN ❌

### Critical Gap
1. **House-understanding analysis** - DISABLED (AI_ANALYSIS_ENABLED=false in .env.example, but true in local .env)
   - **Reason:** No production provider registered
   - **Root cause:** Local Grounding DINO + SAM2 removed; no suitable remote replacement found
   - **Impact:** Autonomous pipeline non-functional; manual analysis unavailable
   - **Providers checked:**
     - hf-vision: 400 "Model not supported by provider hf-inference"
     - grounding-dino-*, OWL-ViT/OWLv2, SAM/SAM2: No HF providers host them
     - COCO-panoptic/ADE20K-SegFormer: Wrong capability (no architectural categories)

### Minor Issues
2. **PDF export** - NOT IMPLEMENTED (returns 501)
   - **Reason:** Needs render pipeline beyond client canvas
   - **Workaround:** Use PNG or side-by-side JPG

---

## WHAT IS MOCKED/TEST-ONLY ⚠️

1. **mockProvider.js** - NOT registered in production
   - **Purpose:** Test fixture only
   - **Functionality:** Jimp-based image heuristics (NOT real AI)
   - **Status:** Explicitly excluded from aiRegistry PROVIDERS array
   - **Can be deleted:** Nothing imports it

---

## WHAT IS MISSING 📝

### Security
1. User authentication - Single API key for all access
2. Role-based access control - No permissions system
3. Audit logging - No access audit trail

### Infrastructure
1. File encryption - Files stored in plain
2. Backup mechanism - No automated backups
3. Cloud storage - Local disk only

### Features
1. PDF export - Not implemented
2. Production house-understanding provider - Need viable remote service
3. Real-time collaboration - No multi-user features
4. Advanced finish simulation - Finish effects are basic (opacity only)
5. 3D preview - No 3D room visualization
6. AR integration - No augmented reality features

---

## CHANGES SINCE PREVIOUS AUDIT

### Previous Audit Date: 2026-08-07
**Location:** `docs/AI_VISUALIZER_ARCHITECTURE_AUDIT.md`

### Key Changes Identified

1. **Provider Registry Changed:**
   - Previous: `[mockProvider, httpVisionProvider, hfVisionProvider, catalogRecommendationProvider]`
   - Current: `[catalogRecommendationProvider, hfSchemeProvider]`
   - **Impact:** `mockProvider`, `httpVisionProvider`, `hfVisionProvider` removed from registry

2. **House-Understanding Status:**
   - Previous: Default to `mock` provider
   - Current: No provider registered, capability disabled
   - **Impact:** Analysis completely non-functional (no fallback)

3. **AI Pipeline Implemented:**
   - Previous: No unified state machine
   - Current: `aiPipeline.service.js` with stage derivation
   - **Impact:** Autonomous pipeline infrastructure exists but non-functional due to analysis disabled

4. **Surface Quality Validation Added:**
   - Previous: No validation layer
   - Current: `surfaceQuality.service.js` with geometric scoring
   - **Impact:** Surfaces now scored on plausibility, containment, object overlap

5. **Removal Quality Validation Added:**
   - Previous: No output-side validation
   - Current: `removalQuality.service.js` with damage check
   - **Impact:** Cleanup rejected if protected regions changed unexpectedly

6. **House-Aware Object Removal Added:**
   - Previous: Manual mask or nothing
   - Current: `objectRemovalMask.service.js` builds default mask from analysis
   - **Impact:** Cleanup now house-aware when analysis available

7. **Object Classification Added:**
   - Previous: No category classification
   - Current: `objectClassification.js` with `unrelated-object` vs `non-paintable-house-component`
   - **Impact:** Objects categorized for removal decisions

8. **Test Coverage Expanded:**
   - Previous: Zero backend tests
   - Current: 76 backend tests, 41 frontend tests
   - **Impact:** Critical functionality now tested

### Verification of Previous Findings

**Previous Audit Claims - Verified:**
- ✅ Single renderer invariant still holds
- ✅ Masks-as-files invariant still holds
- ✅ AI never paints invariant still holds
- ✅ Idempotent AI layers invariant still holds
- ✅ Storage-through-one-module invariant still holds

**Previous Audit Issues - Status:**
- ❌ Excel import transaction bug: NOT FIXED (not addressed since previous audit)
- ❌ `/files/*` auth gap: NOT FIXED (still accepts query param)
- ❌ Access-key fail-open: NOT FIXED (still allows when unset)
- ❌ Optimistic-concurrency UI gap: NOT FIXED (no UI sends updated_at)
- ✅ AI Schemes OOM/freeze: FIXED (bounded preview, sequential generation)

---

## CURRENT WORKFLOW STATE

### Existing Dealer Workflow
```
1. Create project
2. Upload customer's house photo
3. [MANUAL] Click "Understand this photo" → AI Understand tab
4. [MANUAL] Click "Generate N schemes" → AI Schemes tab
5. [MANUAL] Click Apply on scheme
6. [MANUAL] Paint/adjust
7. [MANUAL] Save as concept
8. Export result
```

### Gap vs. Desired Workflow
**Desired:** Upload → AI automatically processes → Dealer reviews → Dealer edits → Export

**Current:** Upload → Manual trigger for each stage → Dealer edits → Export

**Blocker:** House-understanding disabled, so autonomous pipeline cannot start

---

## PRODUCTION READINESS ASSESSMENT

### ✅ Production-Ready Components
1. Catalog-based paint visualization
2. Manual paint application with brush tools
3. LAB-based realistic rendering
4. Project and asset management
5. Paint catalog CRUD
6. Excel import/export
7. Undo/redo functionality
8. Layer management
9. PNG/JPG export
10. Security (minimal but functional for single-dealer use case)

### ❌ Not Production-Ready Components
1. AI house-understanding (disabled, no provider)
2. Autonomous AI pipeline (depends on house-understanding)
3. House-aware object removal (depends on house-understanding)
4. AI surface segmentation (depends on house-understanding)
5. Context-aware recommendations (depends on house-understanding)

### ⚠️ Partially Production-Ready Components
1. Paint recommendations (functional but rule-based only, LLM requires API key)
2. Object removal (functional but not house-aware)
3. Security (functional but minimal, no user auth)

---

## CRITICAL DEPENDENCIES

### External APIs
- **Clipdrop Cleanup API:** Billed, requires CLIPDROP_API_KEY
- **Hugging Face Inference Providers:** Billed, requires HF_API_KEY

### External Libraries
- **express** - Web framework
- **mysql2** - Database driver
- **jimp** - Image processing
- **multer** - File uploads
- **xlsx** - Excel handling
- **zod** - Schema validation
- **uuid** - UUID generation
- **cors, helmet, morgan, express-rate-limit** - Security/middleware

### Frontend Libraries
- **react** - UI framework
- **vite** - Build tool
- **konva** - Canvas rendering
- **zustand** - State management
- **@tanstack/react-query** - Server state
- **idb-keyval** - IndexedDB wrapper
- **radix-ui** - UI primitives
- **tailwindcss** - Styling

---

## RISKS AND MITIGATION

### High Priority Risks
1. **House-understanding provider gap**
   - **Risk:** Core AI functionality non-functional
   - **Mitigation:** Research and implement viable remote provider (Roboflow, Wizart, etc.)

2. **Security minimal**
   - **Risk:** Single key shared access, no audit trail
   - **Mitigation:** Implement user authentication, audit logging (Phase 8)

3. **No backup mechanism**
   - **Risk:** Data loss from disk failure
   - **Mitigation:** Implement automated backups (Phase 8)

### Medium Priority Risks
1. **No file encryption**
   - **Risk:** Sensitive files stored in plain
   - **Mitigation:** Implement encryption at rest (Phase 8)

2. **No rate limiting per user**
   - **Risk:** Abuse of shared API key
   - **Mitigation:** Implement token-based rate limiting (Phase 8)

### Low Priority Risks
1. **Large bundle size**
   - **Risk:** Slow initial load
   - **Mitigation:** Implement code splitting (future)

2. **No TypeScript**
   - **Risk:** Runtime errors, no type safety
   - **Mitigation:** Consider TypeScript migration (future)

---

## RECOMMENDED IMPLEMENTATION PRIORITY

### Immediate (Blocker Resolution)
1. **Resolve house-understanding provider gap** - Critical for AI functionality
   - Research Roboflow House Segmentation API
   - Research Wizart Vision API
   - Test with real house photographs
   - Implement selected provider

### Short-Term (Phase 1-3)
2. **Implement AI provider foundation** - Per-phase configuration, timeouts, retry policy
3. **Implement scene understanding** - Structured analysis output
4. **Implement house cleanup** - House-aware object removal

### Medium-Term (Phase 4-6)
5. **Implement surface understanding** - Architectural segmentation
6. **Implement catalog-constrained recommendations** - Context-aware schemes
7. **Enhance dealer workspace** - AI status, surface review, recommendation cards

### Long-Term (Phase 7-8)
8. **Implement presentation/export** - Dealer presentation workflow
9. **Production hardening** - Authentication, secrets, rate limiting, monitoring

---

## CONCLUSION

The Paint Visualizer application is a well-architected, modular system with solid foundations. The core rendering pipeline, state management, and database schema are production-ready. The primary blocker is the **lack of a production house-understanding AI provider**, which prevents the autonomous AI pipeline from functioning.

The system has comprehensive test coverage (117 tests passing), consistent architectural patterns, and proper separation of concerns. Security is minimal but adequate for the stated use case (single dealer, internal tool).

**Next Critical Step:** Resolve the house-understanding provider gap by researching, testing, and implementing a viable remote AI service for exterior scene analysis and surface segmentation.

---

**Baseline Complete. Ready for implementation planning.**
