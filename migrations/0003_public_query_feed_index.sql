CREATE INDEX IF NOT EXISTS "queries_public_feed_idx"
ON "queries" ("star_count" DESC, "updated_at" DESC, "id" DESC)
WHERE "visibility" = 'public'
  AND "moderation_status" = 'visible'
  AND "deleted_at" IS NULL
  AND "current_version_id" IS NOT NULL;
