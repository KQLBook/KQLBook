# D1 migrations

Apply the canonical schema to the local D1 database:

```sh
npm run db:migrate:local
```

Load the original, CC0-licensed preview queries after the schema migration:

```sh
npx wrangler d1 execute DB --local --config wrangler.local.jsonc --file=migrations/local/0001_demo_seed.sql
```

The seed is idempotent. It stays under `migrations/local/` so the production
migration command does not import demo records.

Import a reviewed KQLSearch crawl manifest into local D1:

```sh
npm run db:ingest:kqlsearch:local -- \
  --manifest ../kqlsearch_queries_metadata_2026-07-26.csv
```

The CSV selects repositories and exact source paths. The importer does not use
query bodies or explanations from KQLSearch. It rechecks each repository's
current SPDX license through GitHub, clones the approved source, parses KQL
from the pinned commit, and writes provenance, required notices, FTS rows, and
embedding outbox work. Re-running the command is idempotent. Add
`--show-skips` to print source paths that are missing or do not contain a
recognized query.

If D1 is restored without its virtual tables, rebuild FTS5 from canonical query
versions:

```sh
npx wrangler d1 execute DB --local --config wrangler.local.jsonc --file=migrations/helpers/rebuild_query_search.sql
```
