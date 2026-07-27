PRAGMA foreign_keys = ON;

-- Better Auth tables. Date values are stored as ISO-8601 text.
CREATE TABLE IF NOT EXISTS "user" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE COLLATE NOCASE,
  "emailVerified" INTEGER NOT NULL DEFAULT 0 CHECK ("emailVerified" IN (0, 1)),
  "image" TEXT,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'user' CHECK ("role" IN ('user', 'admin'))
);

CREATE TABLE IF NOT EXISTS "session" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "expiresAt" TEXT NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" ("userId");

CREATE TABLE IF NOT EXISTS "account" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" TEXT,
  "refreshTokenExpiresAt" TEXT,
  "scope" TEXT,
  "password" TEXT,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  UNIQUE ("providerId", "accountId")
);

CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account" ("userId");

CREATE TABLE IF NOT EXISTS "verification" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" TEXT NOT NULL,
  "createdAt" TEXT,
  "updatedAt" TEXT
);

CREATE INDEX IF NOT EXISTS "verification_identifier_idx"
  ON "verification" ("identifier");

CREATE TABLE IF NOT EXISTS "rateLimit" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "key" TEXT NOT NULL UNIQUE,
  "count" INTEGER NOT NULL,
  "lastRequest" INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "licenses" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "spdx_id" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  "license_url" TEXT NOT NULL,
  "required_notice" TEXT NOT NULL DEFAULT '',
  "ingestion_allowed" INTEGER NOT NULL DEFAULT 0
    CHECK ("ingestion_allowed" IN (0, 1)),
  "reviewed_at" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
);

CREATE TABLE IF NOT EXISTS "source_repositories" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "provider" TEXT NOT NULL CHECK ("provider" IN ('github', 'local')),
  "repository" TEXT NOT NULL,
  "default_branch" TEXT,
  "source_url" TEXT NOT NULL,
  "license_id" TEXT NOT NULL REFERENCES "licenses" ("id") ON DELETE RESTRICT,
  "trusted" INTEGER NOT NULL DEFAULT 0 CHECK ("trusted" IN (0, 1)),
  "created_at" TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  "updated_at" TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  UNIQUE ("provider", "repository")
);

CREATE TABLE IF NOT EXISTS "queries" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "owner_id" TEXT REFERENCES "user" ("id") ON DELETE CASCADE,
  "visibility" TEXT NOT NULL DEFAULT 'private'
    CHECK ("visibility" IN ('private', 'public')),
  "moderation_status" TEXT NOT NULL DEFAULT 'visible'
    CHECK ("moderation_status" IN ('visible', 'unpublished', 'removed')),
  "current_version_id" TEXT,
  "star_count" INTEGER NOT NULL DEFAULT 0 CHECK ("star_count" >= 0),
  "created_at" TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  "updated_at" TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  "published_at" TEXT,
  "deleted_at" TEXT,
  CHECK ("owner_id" IS NOT NULL OR "visibility" = 'public')
);

CREATE INDEX IF NOT EXISTS "queries_owner_updated_idx"
  ON "queries" ("owner_id", "updated_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "queries_public_updated_idx"
  ON "queries" ("visibility", "moderation_status", "updated_at" DESC)
  WHERE "deleted_at" IS NULL;

CREATE TABLE IF NOT EXISTS "query_versions" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "query_id" TEXT NOT NULL REFERENCES "queries" ("id") ON DELETE CASCADE,
  "version_number" INTEGER NOT NULL CHECK ("version_number" > 0),
  "title" TEXT NOT NULL CHECK (length(trim("title")) BETWEEN 1 AND 180),
  "kql" TEXT NOT NULL CHECK (length(trim("kql")) BETWEEN 1 AND 100000),
  "description" TEXT NOT NULL DEFAULT '',
  "explanation" TEXT NOT NULL DEFAULT '',
  "dialect" TEXT NOT NULL CHECK (
    "dialect" IN (
      'sentinel',
      'defender-xdr',
      'azure-data-explorer',
      'azure-resource-graph',
      'intune-device-query'
    )
  ),
  "tables_json" TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid("tables_json") AND json_type("tables_json") = 'array'),
  "operators_json" TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid("operators_json") AND json_type("operators_json") = 'array'),
  "tags_json" TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid("tags_json") AND json_type("tags_json") = 'array'),
  "assumptions_json" TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid("assumptions_json") AND json_type("assumptions_json") = 'array'),
  "validation_warnings_json" TEXT NOT NULL DEFAULT '[]'
    CHECK (
      json_valid("validation_warnings_json")
      AND json_type("validation_warnings_json") = 'array'
    ),
  "ai_generated" INTEGER NOT NULL DEFAULT 0 CHECK ("ai_generated" IN (0, 1)),
  "generation_model" TEXT,
  "content_hash" TEXT NOT NULL,
  "created_by_user_id" TEXT REFERENCES "user" ("id") ON DELETE SET NULL,
  "created_at" TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  UNIQUE ("query_id", "version_number")
);

CREATE INDEX IF NOT EXISTS "query_versions_query_created_idx"
  ON "query_versions" ("query_id", "version_number" DESC);

CREATE TRIGGER IF NOT EXISTS "query_current_version_insert_guard"
BEFORE INSERT ON "queries"
WHEN NEW."current_version_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "query_versions" AS "v"
    WHERE "v"."id" = NEW."current_version_id"
      AND "v"."query_id" = NEW."id"
  )
BEGIN
  SELECT RAISE(ABORT, 'current version must belong to the query');
END;

CREATE TRIGGER IF NOT EXISTS "query_current_version_update_guard"
BEFORE UPDATE OF "current_version_id" ON "queries"
WHEN NEW."current_version_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "query_versions" AS "v"
    WHERE "v"."id" = NEW."current_version_id"
      AND "v"."query_id" = NEW."id"
  )
BEGIN
  SELECT RAISE(ABORT, 'current version must belong to the query');
END;

CREATE TRIGGER IF NOT EXISTS "query_versions_immutable"
BEFORE UPDATE ON "query_versions"
BEGIN
  SELECT RAISE(ABORT, 'query versions are immutable');
END;

CREATE TABLE IF NOT EXISTS "query_provenance" (
  "query_id" TEXT PRIMARY KEY REFERENCES "queries" ("id") ON DELETE CASCADE,
  "source_repository_id" TEXT NOT NULL
    REFERENCES "source_repositories" ("id") ON DELETE RESTRICT,
  "source_path" TEXT NOT NULL,
  "commit_sha" TEXT NOT NULL,
  "query_block_index" INTEGER NOT NULL DEFAULT 0 CHECK ("query_block_index" >= 0),
  "original_author" TEXT NOT NULL,
  "source_url" TEXT NOT NULL,
  "license_id" TEXT NOT NULL REFERENCES "licenses" ("id") ON DELETE RESTRICT,
  "required_notice" TEXT NOT NULL DEFAULT '',
  "created_at" TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  UNIQUE (
    "source_repository_id",
    "source_path",
    "commit_sha",
    "query_block_index"
  )
);

CREATE TRIGGER IF NOT EXISTS "query_provenance_license_guard"
BEFORE INSERT ON "query_provenance"
WHEN NOT EXISTS (
  SELECT 1
  FROM "licenses" AS "l"
  JOIN "source_repositories" AS "s"
    ON "s"."license_id" = "l"."id"
  WHERE "s"."id" = NEW."source_repository_id"
    AND "l"."id" = NEW."license_id"
    AND "l"."ingestion_allowed" = 1
)
BEGIN
  SELECT RAISE(ABORT, 'source license is not approved for ingestion');
END;

CREATE TABLE IF NOT EXISTS "stars" (
  "user_id" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "query_id" TEXT NOT NULL REFERENCES "queries" ("id") ON DELETE CASCADE,
  "created_at" TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  PRIMARY KEY ("user_id", "query_id")
);

CREATE INDEX IF NOT EXISTS "stars_query_created_idx"
  ON "stars" ("query_id", "created_at" DESC);

CREATE TRIGGER IF NOT EXISTS "stars_public_insert_guard"
BEFORE INSERT ON "stars"
WHEN NOT EXISTS (
  SELECT 1
  FROM "queries" AS "q"
  WHERE "q"."id" = NEW."query_id"
    AND "q"."visibility" = 'public'
    AND "q"."moderation_status" = 'visible'
    AND "q"."deleted_at" IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'only visible public queries can be starred');
END;

CREATE TRIGGER IF NOT EXISTS "stars_count_after_insert"
AFTER INSERT ON "stars"
BEGIN
  UPDATE "queries"
  SET "star_count" = "star_count" + 1
  WHERE "id" = NEW."query_id";
END;

CREATE TRIGGER IF NOT EXISTS "stars_count_after_delete"
AFTER DELETE ON "stars"
BEGIN
  UPDATE "queries"
  SET "star_count" = max("star_count" - 1, 0)
  WHERE "id" = OLD."query_id";
END;

CREATE TRIGGER IF NOT EXISTS "queries_remove_non_public_stars"
AFTER UPDATE OF "visibility", "moderation_status", "deleted_at" ON "queries"
WHEN NEW."visibility" != 'public'
  OR NEW."moderation_status" != 'visible'
  OR NEW."deleted_at" IS NOT NULL
BEGIN
  DELETE FROM "stars" WHERE "query_id" = NEW."id";
END;

CREATE TABLE IF NOT EXISTS "search_history" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "user_id" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "raw_request" TEXT NOT NULL,
  "normalized_request" TEXT NOT NULL,
  "filters_json" TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid("filters_json") AND json_type("filters_json") = 'object'),
  "retrieval_mode" TEXT NOT NULL
    CHECK (
      "retrieval_mode" IN ('lexical', 'semantic', 'hybrid', 'generated', 'none')
    ),
  "result_count" INTEGER NOT NULL DEFAULT 0 CHECK ("result_count" >= 0),
  "clicked_query_id" TEXT REFERENCES "queries" ("id") ON DELETE SET NULL,
  "created_at" TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
);

CREATE INDEX IF NOT EXISTS "search_history_user_created_idx"
  ON "search_history" ("user_id", "created_at" DESC, "id" DESC);

CREATE TABLE IF NOT EXISTS "reports" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "query_id" TEXT NOT NULL REFERENCES "queries" ("id") ON DELETE CASCADE,
  "reporter_id" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "reason" TEXT NOT NULL CHECK (
    "reason" IN (
      'spam',
      'malicious-content',
      'copyright',
      'exposed-secret',
      'other'
    )
  ),
  "details" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'open'
    CHECK ("status" IN ('open', 'reviewed', 'dismissed', 'actioned')),
  "reviewed_by" TEXT REFERENCES "user" ("id") ON DELETE SET NULL,
  "reviewed_at" TEXT,
  "created_at" TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "reports_open_reporter_query_idx"
  ON "reports" ("reporter_id", "query_id")
  WHERE "status" = 'open';
CREATE INDEX IF NOT EXISTS "reports_status_created_idx"
  ON "reports" ("status", "created_at" ASC);

CREATE TRIGGER IF NOT EXISTS "reports_public_insert_guard"
BEFORE INSERT ON "reports"
WHEN NOT EXISTS (
  SELECT 1
  FROM "queries" AS "q"
  WHERE "q"."id" = NEW."query_id"
    AND "q"."visibility" = 'public'
    AND "q"."moderation_status" = 'visible'
    AND "q"."deleted_at" IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'only visible public queries can be reported');
END;

CREATE TABLE IF NOT EXISTS "moderation_actions" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "query_id" TEXT NOT NULL REFERENCES "queries" ("id") ON DELETE CASCADE,
  "admin_id" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE RESTRICT,
  "report_id" TEXT REFERENCES "reports" ("id") ON DELETE SET NULL,
  "action" TEXT NOT NULL
    CHECK ("action" IN ('unpublish', 'restore', 'dismiss-report')),
  "reason" TEXT NOT NULL DEFAULT '',
  "previous_visibility" TEXT
    CHECK ("previous_visibility" IS NULL OR "previous_visibility" IN ('private', 'public')),
  "created_at" TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
);

CREATE INDEX IF NOT EXISTS "moderation_actions_query_created_idx"
  ON "moderation_actions" ("query_id", "created_at" DESC);

CREATE TRIGGER IF NOT EXISTS "moderation_actions_admin_guard"
BEFORE INSERT ON "moderation_actions"
WHEN NOT EXISTS (
  SELECT 1 FROM "user"
  WHERE "id" = NEW."admin_id" AND "role" = 'admin'
)
BEGIN
  SELECT RAISE(ABORT, 'moderation actions require an administrator');
END;

CREATE TABLE IF NOT EXISTS "embedding_outbox" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "query_id" TEXT NOT NULL,
  "version_id" TEXT,
  "operation" TEXT NOT NULL CHECK ("operation" IN ('upsert', 'delete')),
  "namespace_kind" TEXT NOT NULL CHECK ("namespace_kind" IN ('public', 'private')),
  "owner_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending'
    CHECK ("status" IN ('pending', 'processing', 'completed', 'failed')),
  "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
  "available_at" TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  "locked_at" TEXT,
  "locked_by" TEXT,
  "last_error" TEXT,
  "created_at" TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  "completed_at" TEXT,
  CHECK (
    ("namespace_kind" = 'public' AND "owner_id" IS NULL)
    OR ("namespace_kind" = 'private' AND "owner_id" IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS "embedding_outbox_pending_idx"
  ON "embedding_outbox" ("status", "available_at" ASC, "created_at" ASC);
CREATE INDEX IF NOT EXISTS "embedding_outbox_query_idx"
  ON "embedding_outbox" ("query_id", "created_at" DESC);

CREATE TRIGGER IF NOT EXISTS "queries_outbox_current_version"
AFTER UPDATE OF "current_version_id" ON "queries"
WHEN NEW."current_version_id" IS NOT NULL
  AND NEW."deleted_at" IS NULL
  AND NEW."moderation_status" = 'visible'
BEGIN
  INSERT INTO "embedding_outbox" (
    "id",
    "query_id",
    "version_id",
    "operation",
    "namespace_kind",
    "owner_id"
  ) VALUES (
    lower(hex(randomblob(16))),
    NEW."id",
    NEW."current_version_id",
    'upsert',
    CASE WHEN NEW."visibility" = 'public' THEN 'public' ELSE 'private' END,
    CASE WHEN NEW."visibility" = 'public' THEN NULL ELSE NEW."owner_id" END
  );
END;

CREATE TRIGGER IF NOT EXISTS "queries_outbox_access_change"
AFTER UPDATE OF "visibility", "moderation_status", "deleted_at" ON "queries"
WHEN OLD."current_version_id" IS NOT NULL
  AND (
    OLD."visibility" != NEW."visibility"
    OR OLD."moderation_status" != NEW."moderation_status"
    OR OLD."deleted_at" IS NOT NEW."deleted_at"
  )
BEGIN
  INSERT INTO "embedding_outbox" (
    "id",
    "query_id",
    "version_id",
    "operation",
    "namespace_kind",
    "owner_id"
  ) VALUES (
    lower(hex(randomblob(16))),
    OLD."id",
    OLD."current_version_id",
    'delete',
    CASE WHEN OLD."visibility" = 'public' THEN 'public' ELSE 'private' END,
    CASE WHEN OLD."visibility" = 'public' THEN NULL ELSE OLD."owner_id" END
  );

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
  WHERE NEW."deleted_at" IS NULL
    AND NEW."moderation_status" = 'visible';
END;

CREATE TRIGGER IF NOT EXISTS "queries_outbox_delete"
AFTER DELETE ON "queries"
WHEN OLD."current_version_id" IS NOT NULL
BEGIN
  INSERT INTO "embedding_outbox" (
    "id",
    "query_id",
    "version_id",
    "operation",
    "namespace_kind",
    "owner_id"
  ) VALUES (
    lower(hex(randomblob(16))),
    OLD."id",
    OLD."current_version_id",
    'delete',
    CASE WHEN OLD."visibility" = 'public' THEN 'public' ELSE 'private' END,
    CASE WHEN OLD."visibility" = 'public' THEN NULL ELSE OLD."owner_id" END
  );
END;

-- This FTS5 table is derived data. Rebuild it from queries and query_versions.
CREATE VIRTUAL TABLE IF NOT EXISTS "query_search" USING fts5(
  "query_id" UNINDEXED,
  "version_id" UNINDEXED,
  "title",
  "tables",
  "description",
  "kql",
  "operators",
  "tags",
  "author",
  "source",
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS "queries_fts_sync"
AFTER UPDATE OF "current_version_id", "deleted_at", "moderation_status" ON "queries"
BEGIN
  DELETE FROM "query_search" WHERE "query_id" = NEW."id";

  INSERT INTO "query_search" (
    "query_id",
    "version_id",
    "title",
    "tables",
    "description",
    "kql",
    "operators",
    "tags",
    "author",
    "source"
  )
  SELECT
    NEW."id",
    "v"."id",
    "v"."title",
    (
      SELECT coalesce(group_concat("value", ' '), '')
      FROM json_each("v"."tables_json")
    ),
    "v"."description",
    "v"."kql",
    (
      SELECT coalesce(group_concat("value", ' '), '')
      FROM json_each("v"."operators_json")
    ),
    (
      SELECT coalesce(group_concat("value", ' '), '')
      FROM json_each("v"."tags_json")
    ),
    coalesce("p"."original_author", ''),
    coalesce("s"."repository", '')
  FROM "query_versions" AS "v"
  LEFT JOIN "query_provenance" AS "p" ON "p"."query_id" = NEW."id"
  LEFT JOIN "source_repositories" AS "s"
    ON "s"."id" = "p"."source_repository_id"
  WHERE "v"."id" = NEW."current_version_id"
    AND "v"."query_id" = NEW."id"
    AND NEW."deleted_at" IS NULL
    AND NEW."moderation_status" = 'visible';
END;

CREATE TRIGGER IF NOT EXISTS "queries_fts_delete"
AFTER DELETE ON "queries"
BEGIN
  DELETE FROM "query_search" WHERE "query_id" = OLD."id";
END;

CREATE TRIGGER IF NOT EXISTS "query_provenance_fts_insert"
AFTER INSERT ON "query_provenance"
BEGIN
  DELETE FROM "query_search" WHERE "query_id" = NEW."query_id";

  INSERT INTO "query_search" (
    "query_id",
    "version_id",
    "title",
    "tables",
    "description",
    "kql",
    "operators",
    "tags",
    "author",
    "source"
  )
  SELECT
    "q"."id",
    "v"."id",
    "v"."title",
    (
      SELECT coalesce(group_concat("value", ' '), '')
      FROM json_each("v"."tables_json")
    ),
    "v"."description",
    "v"."kql",
    (
      SELECT coalesce(group_concat("value", ' '), '')
      FROM json_each("v"."operators_json")
    ),
    (
      SELECT coalesce(group_concat("value", ' '), '')
      FROM json_each("v"."tags_json")
    ),
    NEW."original_author",
    "s"."repository"
  FROM "queries" AS "q"
  JOIN "query_versions" AS "v" ON "v"."id" = "q"."current_version_id"
  JOIN "source_repositories" AS "s"
    ON "s"."id" = NEW."source_repository_id"
  WHERE "q"."id" = NEW."query_id"
    AND "q"."deleted_at" IS NULL
    AND "q"."moderation_status" = 'visible';
END;

CREATE TRIGGER IF NOT EXISTS "query_provenance_fts_update"
AFTER UPDATE ON "query_provenance"
BEGIN
  DELETE FROM "query_search" WHERE "query_id" = NEW."query_id";

  INSERT INTO "query_search" (
    "query_id",
    "version_id",
    "title",
    "tables",
    "description",
    "kql",
    "operators",
    "tags",
    "author",
    "source"
  )
  SELECT
    "q"."id",
    "v"."id",
    "v"."title",
    (
      SELECT coalesce(group_concat("value", ' '), '')
      FROM json_each("v"."tables_json")
    ),
    "v"."description",
    "v"."kql",
    (
      SELECT coalesce(group_concat("value", ' '), '')
      FROM json_each("v"."operators_json")
    ),
    (
      SELECT coalesce(group_concat("value", ' '), '')
      FROM json_each("v"."tags_json")
    ),
    NEW."original_author",
    "s"."repository"
  FROM "queries" AS "q"
  JOIN "query_versions" AS "v" ON "v"."id" = "q"."current_version_id"
  JOIN "source_repositories" AS "s"
    ON "s"."id" = NEW."source_repository_id"
  WHERE "q"."id" = NEW."query_id"
    AND "q"."deleted_at" IS NULL
    AND "q"."moderation_status" = 'visible';
END;
