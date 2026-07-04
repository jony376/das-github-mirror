-- Current labels on each issue with actor attribution.
-- Same shape as pr_labels_by_actor but filtered to target_type = 'issue'.

CREATE OR REPLACE VIEW issue_labels_by_actor AS
WITH latest_events AS (
    SELECT DISTINCT ON (le.repo_full_name, le.target_number, le.label_name)
        le.repo_full_name,
        le.target_number,
        le.label_name,
        le.action,
        le.actor_github_id,
        m.association AS actor_association
    FROM label_events le
    LEFT JOIN maintainers m
        ON m.github_id = le.actor_github_id
        AND m.repo_full_name = LOWER(le.repo_full_name)
    WHERE le.target_type = 'issue'
    ORDER BY le.repo_full_name, le.target_number, le.label_name, le.timestamp DESC
)
SELECT
    repo_full_name,
    target_number AS issue_number,
    label_name,
    actor_github_id,
    actor_association
FROM latest_events
WHERE action = 'labeled';
