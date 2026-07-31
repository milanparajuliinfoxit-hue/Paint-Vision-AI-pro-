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
-- Visualizer Module
-- Server only stores metadata + file references. All pixel work
-- (recolor blending) happens client-side. AI cleanup/segmentation
-- calls a hosted API through a thin server-side proxy.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    client_name     VARCHAR(150) NULL,
    reference_note  VARCHAR(255) NULL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS visualization_jobs (
    id              VARCHAR(36) PRIMARY KEY,             -- UUID, matches folder name on disk
    project_id      INT NULL,
    original_path   VARCHAR(500) NOT NULL,                -- relative path under /uploads
    cleaned_path    VARCHAR(500) NULL,                    -- relative path under /uploads, after AI cleanup
    status          ENUM('uploaded','cleaning','cleaned','failed') NOT NULL DEFAULT 'uploaded',
    error_message   VARCHAR(500) NULL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_job_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- One row per saved "look" a user creates on the client (surface + paint applied).
-- The actual recolored pixels never touch the server as a processing step —
-- the client renders them and optionally uploads the final PNG here just for storage/sharing.
CREATE TABLE IF NOT EXISTS job_results (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    job_id          VARCHAR(36) NOT NULL,
    paint_id        INT NULL,
    surface_label   VARCHAR(100) NULL,                    -- e.g. "front facade", "trim"
    result_path     VARCHAR(500) NOT NULL,                 -- relative path under /uploads, final PNG from client
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_result_job FOREIGN KEY (job_id) REFERENCES visualization_jobs(id) ON DELETE CASCADE,
    CONSTRAINT fk_result_paint FOREIGN KEY (paint_id) REFERENCES paints(id) ON DELETE SET NULL
) ENGINE=InnoDB;
