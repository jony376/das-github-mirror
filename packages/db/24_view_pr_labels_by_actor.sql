-- Current labels on each PR with actor attribution.
-- Collapses label_events to the latest action per (repo, pr, label); only rows
-- where the latest action was "labeled" are included (i.e. label still applied).
-- actor_association is resolved at read time from the live maintainers table: a
-- maintainer (OWNER/MEMBER/COLLABORATOR) gets that role, everyone else NULL.
-- Scoring only tests membership in MAINTAINER_ASSOCIATIONS, so a maintainers-only
-- lookup is lossless — and an indexed PK lookup instead of re-deriving roles.

CREATE OR REPLACE VIEW pr_labels_by_actor AS
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
    WHERE le.target_type = 'pr'
    ORDER BY le.repo_full_name, le.target_number, le.label_name, le.timestamp DESC
)
SELECT
    repo_full_name,
    target_number AS pr_number,
    label_name,
    actor_github_id,
    actor_association
FROM latest_events
WHERE action = 'labeled';
