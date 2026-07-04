-- Aggregates review counts per PR by review type.
-- Maintainer-only CHANGES_REQUESTED count is the scoring-relevant field.
-- The reviewer's maintainer status is resolved at read time against the live
-- maintainers table, falling back to the stored ingest snapshot otherwise.

CREATE OR REPLACE VIEW pr_review_summary AS
SELECT
    r.repo_full_name,
    r.pr_number,
    COUNT(*) FILTER (WHERE r.review_state = 'CHANGES_REQUESTED'
                       AND COALESCE(m.association, r.reviewer_association)
                           IN ('OWNER', 'MEMBER', 'COLLABORATOR'))
        AS maintainer_changes_requested_count,
    COUNT(*) FILTER (WHERE r.review_state = 'CHANGES_REQUESTED') AS changes_requested_count,
    COUNT(*) FILTER (WHERE r.review_state = 'APPROVED') AS approved_count,
    COUNT(*) FILTER (WHERE r.review_state = 'COMMENTED') AS commented_count
FROM reviews r
LEFT JOIN maintainers m
    ON m.github_id = r.reviewer_github_id
    AND m.repo_full_name = LOWER(r.repo_full_name)
GROUP BY r.repo_full_name, r.pr_number;
