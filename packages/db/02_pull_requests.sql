-- Pull requests

CREATE TABLE IF NOT EXISTS pull_requests (
    repo_full_name          VARCHAR(255)    NOT NULL,
    pr_number               INTEGER         NOT NULL,
    author_github_id        VARCHAR(255),
    author_login            VARCHAR(255),
    author_association      VARCHAR(20),    -- ingest snapshot; live role resolved at serve time via the maintainers table
    title                   TEXT,
    body                    TEXT,
    state                   VARCHAR(10)     NOT NULL,
    created_at              TIMESTAMPTZ       NOT NULL,
    closed_at               TIMESTAMPTZ,
    merged_at               TIMESTAMPTZ,
    updated_at              TIMESTAMPTZ,
    last_edited_at          TIMESTAMPTZ,
    merged_by_login         VARCHAR(255),
    base_ref                VARCHAR(255),
    head_ref                VARCHAR(255),
    head_repo_full_name     VARCHAR(255),
    head_sha                VARCHAR(40),
    base_sha                VARCHAR(40),
    merge_base_sha          VARCHAR(40),
    additions               INTEGER,
    deletions               INTEGER,
    commits_count           INTEGER,
    labels                  TEXT[],
    closing_issue_numbers   INTEGER[],
    scoring_data_stored     BOOLEAN         NOT NULL DEFAULT FALSE,

    PRIMARY KEY (repo_full_name, pr_number),
    CONSTRAINT pull_requests_merged_has_merged_at
        CHECK (state != 'MERGED' OR merged_at IS NOT NULL)
);

-- Backfill for existing deployments: GitHub's pull request updated_at, used by
-- the nightly incremental backfill to skip re-fetching PR metadata that hasn't
-- changed since last stored. Null on historic rows is treated as "unknown" and
-- forces a re-fetch (fail-safe), so no UPDATE is needed.
ALTER TABLE pull_requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_pull_requests_author      ON pull_requests(author_github_id);
CREATE INDEX IF NOT EXISTS idx_pull_requests_state       ON pull_requests(state);
CREATE INDEX IF NOT EXISTS idx_pull_requests_merged_at   ON pull_requests(merged_at);
