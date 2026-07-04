-- Conversation thread comments (issues and PRs)
-- In GitHub's data model, PR thread comments and issue comments use the same API.
-- This table covers both. The comment_context column distinguishes them.
-- Inline code review comments (on specific diff lines) are in review_comments.sql.

CREATE TABLE IF NOT EXISTS comments (
    repo_full_name      VARCHAR(255)    NOT NULL,
    comment_id          BIGINT          NOT NULL,
    target_number       INTEGER         NOT NULL,
    comment_context     VARCHAR(10)     NOT NULL DEFAULT 'issue',
    author_github_id    VARCHAR(255),
    author_login        VARCHAR(255),
    author_association  VARCHAR(20),    -- ingest snapshot; live role resolved at serve time via the maintainers table
    body                TEXT,
    created_at          TIMESTAMPTZ       NOT NULL,
    updated_at          TIMESTAMPTZ,

    PRIMARY KEY (repo_full_name, comment_id)
);

-- comment_context: 'issue' or 'pr' — derived from whether issue.pull_request
-- is present in the webhook payload. Lets you query "all PR thread comments"
-- or "all issue comments" without joining to another table.

CREATE INDEX IF NOT EXISTS idx_comments_target      ON comments(repo_full_name, target_number);
CREATE INDEX IF NOT EXISTS idx_comments_author      ON comments(author_github_id);
CREATE INDEX IF NOT EXISTS idx_comments_created     ON comments(created_at);
CREATE INDEX IF NOT EXISTS idx_comments_context     ON comments(comment_context);
