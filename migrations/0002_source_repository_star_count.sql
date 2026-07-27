ALTER TABLE "source_repositories"
ADD COLUMN "star_count" INTEGER NOT NULL DEFAULT 0
CHECK ("star_count" >= 0);
