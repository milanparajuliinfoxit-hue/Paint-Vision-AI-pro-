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
    order_index         INT NOT NULL DEFAULT 0,
    locked              TINYINT(1) NOT NULL DEFAULT 0,
    visible             TINYINT(1) NOT NULL DEFAULT 1,
    deleted_at          TIMESTAMP(3) NULL,                -- soft-delete: keeps the row (and its mask file) so undo can restore it instead of recreating a new id
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_layer_asset FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
    CONSTRAINT fk_layer_paint FOREIGN KEY (current_color_id) REFERENCES paints(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Append-only undo/redo log, persisted per project so history survives a
-- refresh instead of dying as an in-memory stack.
CREATE TABLE IF NOT EXISTS history_entries (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    project_id      INT NOT NULL,
    action          VARCHAR(50) NOT NULL,
    before_state    JSON NULL,
    after_state     JSON NULL,
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
