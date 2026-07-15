# Database package (packages/db)

Drizzle schema, migrations, and client. Data-model doctrine: `docs/ARCHITECTURE.md`
§Data model essentials.

## Migrations

- Edit `src/schema/*.ts`, then `pnpm db:generate` — it writes the migration into
  `packages/db/drizzle/`, which ships with the schema change (CI fails on an
  uncommitted drift between schema and migrations). `pnpm db:migrate` applies.
- Migrations continue the existing chain — no baselines, one drizzle config.
- The `admin_sql_panel` role is granted SELECT on future tables via
  `ALTER DEFAULT PRIVILEGES` (admin SQL panel). A new table holding plaintext
  credential or secret material must ship a `REVOKE`/column-scoped carve-out in its
  own migration (precedent: `verification_tokens`, `users.opaque_registration` in
  `0050_admin-plane-foundations.sql`) — nothing enforces this automatically.

## Shape-test contract

`src/schema/shape-*.test.ts` enforces schema conventions; a new table or column must
satisfy them or the suite fails:

- Every FK column leads an index/unique/PK, or joins the explicit
  `NOT_NULL_PARTIAL_INDEXES` allowlist (predicate exactly `<col> IS NOT NULL`).
- Every money column is nano-USD `bigint` and registered in the shape-money registry.
- Every table declares `relations()`.
- uuidv7 primary keys (`service_evidence` is the one grandfathered exception).
- Closed sets are pgEnums, never bare `text()` (`jobs.type` is text by design).
- The `jobs` table has exactly its four partial indexes (claim probe, active dedupe,
  succeeded prune, discarded prune).

## Tests

- Two runners: normal vitest, plus `*.workers.test.ts` under
  `@cloudflare/vitest-pool-workers` (`test:workers`) — the workers files are excluded
  from the normal vitest config.

## Ownership

- Every table has exactly one owning slice (single-writer-per-table); schema changes
  belong with the owning slice's work.
