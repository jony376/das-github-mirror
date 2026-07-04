-- Joins the closing_issue_numbers array on each PR against actual issue records.
-- Provides all raw fields validators need for issue validity checks.
-- issue_author_association is resolved at read time against the live maintainers
-- table, falling back to the stored ingest snapshot for non-maintainers.

CREATE OR REPLACE VIEW pr_linked_issues AS
SELECT
    p.repo_full_name,
    p.pr_number,
    p.author_github_id     AS pr_author_github_id,
    p.merged_at             AS pr_merged_at,
    p.created_at            AS pr_created_at,
    linked.issue_number,
    i.author_github_id      AS issue_author_github_id,
    COALESCE(m.association, i.author_association) AS issue_author_association,
    i.title                 AS issue_title,
    i.state                 AS issue_state,
    i.state_reason          AS issue_state_reason,
    i.labels                AS issue_labels,
    i.created_at            AS issue_created_at,
    i.closed_at             AS issue_closed_at,
    i.updated_at            AS issue_updated_at,
    i.solved_by_pr          AS issue_solved_by_pr,
    i.is_transferred
FROM pull_requests p
CROSS JOIN LATERAL unnest(p.closing_issue_numbers) AS linked(issue_number)
JOIN issues i
    ON i.repo_full_name = p.repo_full_name
    AND i.issue_number = linked.issue_number
LEFT JOIN maintainers m
    ON m.github_id = i.author_github_id
    AND m.repo_full_name = LOWER(i.repo_full_name);
