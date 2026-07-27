DROP TRIGGER IF EXISTS "queries_outbox_current_version";

CREATE TRIGGER "queries_outbox_current_version"
AFTER UPDATE OF "current_version_id" ON "queries"
WHEN OLD."current_version_id" IS NOT NEW."current_version_id"
BEGIN
  INSERT INTO "embedding_outbox" (
    "id",
    "query_id",
    "version_id",
    "operation",
    "namespace_kind",
    "owner_id"
  )
  SELECT
    lower(hex(randomblob(16))),
    OLD."id",
    OLD."current_version_id",
    'delete',
    CASE WHEN OLD."visibility" = 'public' THEN 'public' ELSE 'private' END,
    CASE WHEN OLD."visibility" = 'public' THEN NULL ELSE OLD."owner_id" END
  WHERE OLD."current_version_id" IS NOT NULL;

  INSERT INTO "embedding_outbox" (
    "id",
    "query_id",
    "version_id",
    "operation",
    "namespace_kind",
    "owner_id"
  )
  SELECT
    lower(hex(randomblob(16))),
    NEW."id",
    NEW."current_version_id",
    'upsert',
    CASE WHEN NEW."visibility" = 'public' THEN 'public' ELSE 'private' END,
    CASE WHEN NEW."visibility" = 'public' THEN NULL ELSE NEW."owner_id" END
  WHERE NEW."current_version_id" IS NOT NULL
    AND NEW."deleted_at" IS NULL
    AND NEW."moderation_status" = 'visible';
END;
