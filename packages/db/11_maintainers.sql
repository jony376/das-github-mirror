-- Maintainers resolved live from GitHub (direct collaborators + org members).
-- Populated per registered+installed repo by MaintainerPopulateService and read
-- at serve time to resolve author/actor association WITHOUT mutating the stored
-- per-row ingest snapshots. repo_full_name is stored lowercased so every read
-- joins as `m.repo_full_name = LOWER(<src>.repo_full_name)` and still uses the
-- primary-key index (LOWER applied to the probe side only).

CREATE TABLE IF NOT EXISTS maintainers (
    repo_full_name  VARCHAR(255) NOT NULL,
    github_id       VARCHAR(255) NOT NULL,
    login           VARCHAR(255),
    association     VARCHAR(20)  NOT NULL,   -- OWNER | MEMBER | COLLABORATOR
    refreshed_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    PRIMARY KEY (repo_full_name, github_id)
);
