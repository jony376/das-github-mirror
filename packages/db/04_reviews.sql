-- PR reviews

CREATE TABLE IF NOT EXISTS reviews (
    repo_full_name          VARCHAR(255)    NOT NULL,
    pr_number               INTEGER         NOT NULL,
    reviewer_github_id      VARCHAR(255),
    reviewer_login          VARCHAR(255),
    reviewer_association    VARCHAR(20),    -- ingest snapshot; live role resolved at serve time via the maintainers table
    review_state            VARCHAR(30)     NOT NULL,
    submitted_at            TIMESTAMPTZ     NOT NULL,

    PRIMARY KEY (repo_full_name, pr_number, reviewer_github_id, submitted_at)
);

CREATE INDEX IF NOT EXISTS idx_reviews_pr ON reviews(repo_full_name, pr_number);
