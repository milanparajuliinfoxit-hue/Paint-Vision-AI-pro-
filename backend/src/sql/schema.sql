-- Paint Visualizer — MySQL Schema
-- Run: mysql -u root -p paint_visualizer < schema.sql

CREATE DATABASE IF NOT EXISTS paint_visualizer CHARACTER SET utf8mb4;
USE paint_visualizer;

-- ---------------------------------------------------------------
-- Catalog Module
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paints (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    s_id            INT,                          -- original id from source Excel, kept for traceability
    color_code      VARCHAR(50) NOT NULL,
    color_name      VARCHAR(150) NOT NULL,
    tenprotect      TINYINT(1) NOT NULL DEFAULT 0,
    brightshine     TINYINT(1) NOT NULL DEFAULT 0,
    colorfuleco     TINYINT(1) NOT NULL DEFAULT 0,
    jotashield      TINYINT(1) NOT NULL DEFAULT 0,
    majestic        TINYINT(1) NOT NULL DEFAULT 0,
    sevenprotect    TINYINT(1) NOT NULL DEFAULT 0,
    surprised       TINYINT(1) NOT NULL DEFAULT 0,
    r_value         SMALLINT UNSIGNED NOT NULL,
    g_value         SMALLINT UNSIGNED NOT NULL,
    b_value         SMALLINT UNSIGNED NOT NULL,
    hex_value       VARCHAR(7) GENERATED ALWAYS AS (
                        CONCAT('#',
                          LPAD(HEX(r_value), 2, '0'),
                          LPAD(HEX(g_value), 2, '0'),
                          LPAD(HEX(b_value), 2, '0'))
                    ) STORED,
    is_deleted      TINYINT(1) NOT NULL DEFAULT 0,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_color_code (color_code),
    KEY idx_color_name (color_name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS import_log (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    file_name       VARCHAR(255) NOT NULL,
    rows_new        INT DEFAULT 0,
    rows_updated    INT DEFAULT 0,
    rows_skipped    INT DEFAULT 0,
    rows_error      INT DEFAULT 0,
    error_detail    JSON NULL,
    imported_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ---------------------------------------------------------------
-- Visualizer Module (v2) — project-centric, layer/mask based.
-- Server only stores metadata + file references. All pixel work
-- (recolor blending, mask compositing) happens client-side. AI
-- cleanup calls a hosted API through a thin server-side proxy.
--
-- Retires v1's `visualization_jobs` (renamed/expanded -> `assets`) and
-- `job_results` (superseded by `concepts` + `export_jobs`) — no prod
-- data to preserve, this is still pre-release scaffold.
-- ---------------------------------------------------------------
DROP TABLE IF EXISTS job_results;
DROP TABLE IF EXISTS visualization_jobs;

-- name/status/cover_asset_id/tags are new in v2; runSchema.js additionally
-- ALTERs an already-migrated dev DB in place to add them (this
-- CREATE...IF NOT EXISTS only covers a genuinely fresh database).
CREATE TABLE IF NOT EXISTS projects (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    name            VARCHAR(150) NULL,
    client_name     VARCHAR(150) NULL,
    reference_note  VARCHAR(255) NULL,
    status          ENUM('draft','in_review','client_approved','archived') NOT NULL DEFAULT 'draft',
    cover_asset_id  VARCHAR(36) NULL,
    tags            JSON NULL,
    -- Index into this project's history_entries the client's local undo
    -- stack was last positioned at (-1 = nothing applied). Undo/redo apply
    -- their mutation instantly and locally, then mirror to history_entries
    -- for the log — but the log is append-only and never records an
    -- undo/redo itself, so without a persisted pointer a page reload has no
    -- way to know how far back the user had undone and re-derives the
    -- pointer as "everything in the log is applied," which is wrong
    -- whenever anything was undone and not redone before reload.
    undo_pointer    INT NOT NULL DEFAULT -1,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- Millisecond precision: the PATCH conflict check (Section 7) compares
    -- updated_at against a client-held value, and second-resolution
    -- timestamps make same-second edits indistinguishable.
    updated_at      TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

-- An uploaded photo and its derived state. One row per photo (original +
-- cleaned path live together, matching the single AI-cleanup call per photo).
CREATE TABLE IF NOT EXISTS assets (
    id                  VARCHAR(36) PRIMARY KEY,          -- UUID, matches folder name on disk
    project_id          INT NULL,
    label               VARCHAR(150) NULL,                 -- user-assigned display name (rename); falls back to Original/Cleaned
    original_path       VARCHAR(500) NOT NULL,             -- relative path under /uploads
    cleaned_path        VARCHAR(500) NULL,                 -- relative path under /uploads, after AI cleanup
    width               INT NULL,
    height              INT NULL,
    exif_orientation    SMALLINT NULL,
    status              ENUM('uploaded','cleaning','cleaned','failed') NOT NULL DEFAULT 'uploaded',
    error_message       VARCHAR(500) NULL,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_asset_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- One row per paintable surface region within an asset. The mask itself is a
-- compressed alpha PNG on disk (via storage.service, same pattern as photos) —
-- never inline pixel data here, so undo snapshots and API payloads stay cheap.
CREATE TABLE IF NOT EXISTS layers (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    asset_id            VARCHAR(36) NOT NULL,
    name                VARCHAR(150) NOT NULL,
    mask_path           VARCHAR(500) NULL,
    created_via         ENUM('brush','magic-wand','lasso','rect','polygon','ai-surface') NOT NULL,
    current_color_id    INT NULL,
    opacity             DECIMAL(4,3) NOT NULL DEFAULT 1.000,
    finish_override     VARCHAR(50) NULL,
    ai_surface_key      VARCHAR(80) NULL,          -- links a layer to a detected_surfaces.class_key from AI analysis
    ai_analysis_id      INT NULL,                  -- ai_jobs.id that produced the surface; (ai_analysis_id, ai_surface_key) is the idempotency key for AI layer applies
    ai_scheme_id        INT NULL,                  -- paint_recommendations.id that mapped the color, when the layer came from a scheme apply
    order_index         INT NOT NULL DEFAULT 0,
    locked              TINYINT(1) NOT NULL DEFAULT 0,
    visible             TINYINT(1) NOT NULL DEFAULT 1,
    deleted_at          TIMESTAMP(3) NULL,                -- soft-delete: keeps the row (and its mask file) so undo can restore it instead of recreating a new id
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_layer_asset FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
    CONSTRAINT fk_layer_paint FOREIGN KEY (current_color_id) REFERENCES paints(id) ON DELETE SET NULL,
    -- One AI layer per surface per analysis: re-applying a scheme/analysis
    -- updates the existing row in place instead of inserting duplicates
    -- (NULL ai_analysis_id rows — hand-drawn layers — are untouched by MySQL's
    -- UNIQUE semantics, which treat NULLs as distinct).
    UNIQUE KEY uq_layers_ai_surface (ai_analysis_id, ai_surface_key)
) ENGINE=InnoDB;

-- Append-only undo/redo log, persisted per project so history survives a
-- refresh instead of dying as an in-memory stack. Rows are NEVER deleted or
-- rewritten (see mask-file-immutability's sibling rule for this log) — a
-- row that becomes an abandoned redo branch (the user undid it, then made a
-- different edit instead of redoing it) is marked via superseded_at rather
-- than removed, so the full audit trail always stays intact on disk/DB.
-- superseded_at IS NULL means "still a candidate for redo/hydration replay";
-- non-NULL means "abandoned branch — excluded from the reconstructed undo
-- stack, but still a real, queryable row." Existing rows default to NULL
-- (active), which exactly preserves pre-existing behavior for history
-- written before this column existed.
CREATE TABLE IF NOT EXISTS history_entries (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    project_id      INT NOT NULL,
    action          VARCHAR(50) NOT NULL,
    before_state    JSON NULL,
    after_state     JSON NULL,
    superseded_at   TIMESTAMP(3) NULL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_history_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- A saved "look" — a named snapshot of layer/color state a dealer can return to
-- or compare against another Concept.
CREATE TABLE IF NOT EXISTS concepts (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    project_id      INT NOT NULL,
    name            VARCHAR(150) NOT NULL,
    thumbnail_path  VARCHAR(500) NULL,
    layer_color_map JSON NULL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_concept_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Client-rendered export (PNG / side-by-side JPG today; PDF with dealer
-- branding is a follow-up needing a render pipeline beyond client <canvas>).
CREATE TABLE IF NOT EXISTS export_jobs (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    project_id      INT NOT NULL,
    format          ENUM('pdf','png','side-by-side-jpg') NOT NULL,
    comparison_mode ENUM('side-by-side','slider','split','fade') NULL,
    status          ENUM('pending','ready','failed') NOT NULL DEFAULT 'pending',
    file_path       VARCHAR(500) NULL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_export_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------
-- AI Understanding Module — structured house understanding.
-- The AI layer never invents colors or paints: every recommendation maps
-- surfaces to paints that exist in the `paints` catalog. Mask pixels stay on
-- disk as alpha PNGs (via storage.service) — these tables hold metadata only.
--
-- ai_jobs is the versioned audit log for every AI capability run: which
-- provider produced it, which model version, confidence, timing, and failure
-- reason, so every AI result is explainable and replaceable.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_jobs (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    asset_id            VARCHAR(36) NOT NULL,
    job_type            ENUM('house-understanding','paint-recommendation','house-visualization','house-isolation') NOT NULL,
    provider            VARCHAR(50) NOT NULL,
    model_version       VARCHAR(100) NULL,
    status              ENUM('running','succeeded','failed') NOT NULL DEFAULT 'running',
    confidence          DECIMAL(5,4) NULL,
    processing_time_ms  INT NULL,
    failure_reason      VARCHAR(500) NULL,
    output_json         JSON NULL,
    -- Generated column: job_type while status='running', NULL otherwise.
    -- MySQL unique indexes don't enforce uniqueness across NULLs, so
    -- uq_ai_jobs_running below only ever rejects a second 'running' row for
    -- the same (asset_id, job_type) — a real database constraint against
    -- duplicate concurrent AI runs, correct even across multiple app
    -- instances (an in-process lock, e.g. inFlightLock.service.js, is not:
    -- it only protects a single Node process).
    running_claim       VARCHAR(30) GENERATED ALWAYS AS (CASE WHEN status = 'running' THEN job_type ELSE NULL END) STORED,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_ai_job_asset FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
    KEY idx_ai_job_asset (asset_id),
    UNIQUE KEY uq_ai_jobs_running (asset_id, running_claim)
) ENGINE=InnoDB;

-- Painatable / non-paintable surface regions detected in a photo. `paintable`
-- is the hard guard the UI/brush tooling reads: never paint a non-paintable
-- surface, never lock a layer to a roof.
CREATE TABLE IF NOT EXISTS detected_surfaces (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    analysis_id     INT NOT NULL,
    asset_id        VARCHAR(36) NOT NULL,
    class_key       VARCHAR(50) NOT NULL,
    display_name    VARCHAR(150) NULL,
    paintable       TINYINT(1) NOT NULL DEFAULT 1,
    confidence      DECIMAL(5,4) NULL,
    mask_path       VARCHAR(500) NULL,
    geometry        JSON NULL,
    average_color   JSON NULL,
    properties      JSON NULL,
    CONSTRAINT fk_surface_analysis FOREIGN KEY (analysis_id) REFERENCES ai_jobs(id) ON DELETE CASCADE,
    CONSTRAINT fk_surface_asset FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
    KEY idx_surface_asset (asset_id)
) ENGINE=InnoDB;

-- Removable obstructions (trees, cars, people, garden furniture, ...) — not
-- paintable, candidates for the object-removal proxy.
CREATE TABLE IF NOT EXISTS detected_objects (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    analysis_id     INT NOT NULL,
    asset_id        VARCHAR(36) NOT NULL,
    class_key       VARCHAR(50) NOT NULL,
    display_name    VARCHAR(150) NULL,
    confidence      DECIMAL(5,4) NULL,
    mask_path       VARCHAR(500) NULL,
    geometry        JSON NULL,
    CONSTRAINT fk_object_analysis FOREIGN KEY (analysis_id) REFERENCES ai_jobs(id) ON DELETE CASCADE,
    CONSTRAINT fk_object_asset FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
    KEY idx_object_asset (asset_id)
) ENGINE=InnoDB;

-- Persisted generated paint schemes. scheme_json holds the role→surface→paint
-- mapping; colors are always catalog paint IDs resolved to full paint objects
-- by the API on read. status tracks whether the dealer applied a scheme.
CREATE TABLE IF NOT EXISTS paint_recommendations (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    project_id      INT NOT NULL,
    asset_id        VARCHAR(36) NOT NULL,
    scheme_name     VARCHAR(150) NOT NULL,
    tagline         VARCHAR(255) NULL,
    rationale       JSON NULL,
    scheme_json     JSON NOT NULL,
    status          ENUM('draft','applied') NOT NULL DEFAULT 'draft',
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_reco_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_reco_asset FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
    KEY idx_reco_asset (asset_id)
) ENGINE=InnoDB;

-- Generated Gemini recolor visualizations. `assets` has exactly one
-- cleaned_path (singular); this is the "N generated visualizations per
-- asset" table nothing in the pre-Gemini schema represented.
-- surface_color_plan is a snapshot of exactly what was sent to the
-- provider (surfaceKey -> paintId) — kept even if the referenced scheme
-- later changes, so a generated image always stays traceable to the real
-- catalog colors that produced it (governing brief Section 15).
-- Doubles as the unified AI *revision* timeline (Gemini-first migration):
-- every Gemini image operation on an asset — prepare-house, remove-objects,
-- visualize-paint, change-color — writes one row here, chained via
-- parent_revision_id, so "Original -> Prepared -> Painted -> re-colored" is
-- a real traceable lineage, not four disconnected features. Reused rather
-- than renamed/split into a second table (governing brief §31 "avoid
-- redundant storage models") — the concept (one generated image + the
-- inputs that produced it) was already exactly this table's shape; it only
-- needed task_type/parent_revision_id/source_path to become general.
CREATE TABLE IF NOT EXISTS ai_visualizations (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    asset_id            VARCHAR(36) NOT NULL,
    job_id              INT NOT NULL,
    scheme_id           INT NULL,
    task_type           ENUM('prepare_house','remove_objects','visualize_paint','change_color') NOT NULL DEFAULT 'visualize_paint',
    parent_revision_id  INT NULL,
    source_path         VARCHAR(500) NULL,
    surface_color_plan  JSON NOT NULL,
    user_intent         VARCHAR(500) NULL,
    result_path         VARCHAR(500) NOT NULL,
    status              ENUM('pending','ready','failed') NOT NULL DEFAULT 'pending',
    validation_json      JSON NULL,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_viz_asset FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
    CONSTRAINT fk_viz_job FOREIGN KEY (job_id) REFERENCES ai_jobs(id) ON DELETE CASCADE,
    CONSTRAINT fk_viz_scheme FOREIGN KEY (scheme_id) REFERENCES paint_recommendations(id) ON DELETE SET NULL,
    CONSTRAINT fk_viz_parent FOREIGN KEY (parent_revision_id) REFERENCES ai_visualizations(id) ON DELETE SET NULL,
    KEY idx_viz_asset (asset_id)
) ENGINE=InnoDB;
