-- Run this after a D1 restore or when the FTS5 index needs to be regenerated.
DELETE FROM query_search;

INSERT INTO query_search (
  query_id,
  version_id,
  title,
  tables,
  description,
  kql,
  operators,
  tags,
  author,
  source
)
SELECT
  q.id,
  v.id,
  v.title,
  (
    SELECT coalesce(group_concat(value, ' '), '')
    FROM json_each(v.tables_json)
  ),
  v.description,
  v.kql,
  (
    SELECT coalesce(group_concat(value, ' '), '')
    FROM json_each(v.operators_json)
  ),
  (
    SELECT coalesce(group_concat(value, ' '), '')
    FROM json_each(v.tags_json)
  ),
  coalesce(p.original_author, ''),
  coalesce(s.repository, '')
FROM queries AS q
JOIN query_versions AS v ON v.id = q.current_version_id
LEFT JOIN query_provenance AS p ON p.query_id = q.id
LEFT JOIN source_repositories AS s ON s.id = p.source_repository_id
WHERE q.deleted_at IS NULL
  AND q.moderation_status = 'visible';

INSERT INTO query_search(query_search) VALUES ('optimize');
