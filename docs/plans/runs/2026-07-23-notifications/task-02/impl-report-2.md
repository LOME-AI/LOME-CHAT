# Task 02 — DB migrations — impl report 2 (fix)

## Objective

Fix the one VALIDATED Critical from the Task 02 audit: migration 0058 adds enum value
`'web'` to `device_platform` AND references that literal in the `device_tokens_web_keys_present`
CHECK in the same migration/transaction. Postgres rejects using a freshly-added enum value in
the transaction that added it (`ERROR: unsafe use of new value "web" of enum type device_platform`)
whenever the enum type is already committed — i.e. every incremental/production deploy applying
0058 after 0057 is committed. Fix: express the CHECK against `platform::text = 'web'` (cast, no
bare enum literal), regenerate 0058 so `pnpm db:generate` reports no drift, and PROVE the
migration applies clean **incrementally** using the real migrate binary. Behavior identical.

## Files changed

- `packages/db/src/schema/device-tokens.ts` — the `device_tokens_web_keys_present` CHECK
  expression now casts `platform` to text before comparing to `'web'`; added a comment recording
  the enum-add-then-use hazard the cast avoids.
- `packages/db/drizzle/0058_melted_norman_osborn.sql` (regenerated) — CHECK line now emits
  `("device_tokens"."platform"::text = 'web')`; all other statements byte-identical to before.
- `packages/db/drizzle/meta/0058_snapshot.json` (regenerated) — matches the new CHECK expression.
- `packages/db/drizzle/meta/_journal.json` — 0058 entry regenerated (new `when` timestamp;
  a normal consequence of re-running `db:generate` for the same index).

No other file touched. Everything the audit affirmed correct (table shape, quiet-hours CHECKs,
`lastReadSeq`, relations, all Task-02 tests) is unchanged.

## Schema check-expression — before / after

Before (bare enum-literal comparison — the bug):
```
sql`(${table.platform} = 'web') = (${table.p256dh} IS NOT NULL) AND (${table.platform} = 'web') = (${table.auth} IS NOT NULL)`
```
After (cast to text — applies clean incrementally):
```
sql`(${table.platform}::text = 'web') = (${table.p256dh} IS NOT NULL) AND (${table.platform}::text = 'web') = (${table.auth} IS NOT NULL)`
```

Regenerated migration CHECK line (`0058_melted_norman_osborn.sql:24`):
```
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_web_keys_present" CHECK (("device_tokens"."platform"::text = 'web') = ("device_tokens"."p256dh" IS NOT NULL) AND ("device_tokens"."platform"::text = 'web') = ("device_tokens"."auth" IS NOT NULL));
```

## PROOF — incremental apply (real drizzle-kit `migrate` binary)

The prior report's "green through both migrator paths" was fresh-DB, all-migrations-in-one-
transaction paths, which structurally cannot surface this bug. This run reproduces the true
production/`pnpm db:migrate` path: prior migrations committed, then 0058 applied ALONE in its
own transaction.

Setup: created a throwaway DB `hushbox_inc_test` on the local Postgres (via `pg` Client).

1. Removed 0058 from `_journal.json`, then applied 0000–0057 via the real binary
   (`NODE_ENV=development MIGRATION_DATABASE_URL=…/hushbox_inc_test tsx …/drizzle-kit/bin.cjs migrate`):
   → `migrations applied successfully!` exit 0.
   Verified enum committed WITHOUT `web`: `device_platform labels BEFORE 0058: [ 'ios', 'android' ]`,
   and 0000–0057 recorded in `drizzle.__drizzle_migrations`.
2. Restored 0058 into `_journal.json`, then ran the binary again — only 0058 pending, applied
   alone against the DB where the enum type is already committed:
   → `migrations applied successfully!` exit 0. (This is exactly the case that fails with the
   bare-literal CHECK.)
3. Verified resulting state on the incrementally-migrated DB:
   - `device_platform labels AFTER 0058: [ 'ios', 'android', 'web' ]`
   - `device_tokens_web_keys_present` CHECK present:
     `CHECK (((((platform)::text = 'web'::text) = (p256dh IS NOT NULL)) AND (((platform)::text = 'web'::text) = (auth IS NOT NULL))))`
   - `notification_preferences` table exists; 59 migrations recorded (0000–0058).

Throwaway DB dropped after the proof. (Behavioral CHECK enforcement — web-row⟺keys both
directions — is pinned by the 9 existing integration tests in `notification-schema.integration.test.ts`,
which run against the fully-seeded schema; the bare throwaway DB has no seeded users to insert against.)

## Local dev-DB contamination note (not a code defect)

The first `pnpm test:db` after regeneration failed at its `db:migrate` step because the local dev
DB still had the OLD 0058 recorded (CHECK `platform = 'web'::device_platform`) with the prior
task's timestamp, while the regenerated 0058 carries a new `when` — so drizzle-kit saw a phantom
pending migration and tried to re-`ADD VALUE 'web'`. This is a local-only artifact of the prior
task having applied old-0058 to the dev DB; in production/CI 0058 was never applied, so no such
mismatch exists. `pnpm db:reset` (fresh) cleared it — the dev DB now carries the cast-based CHECK —
and `test:db` then passed clean. Raising it only for transparency; nothing to fix.

## Self-gate (after last edit)

- `pnpm db:generate` — pass — "No schema changes, nothing to migrate" (no drift; the schema
  comment does not affect generated SQL).
- Incremental apply via real `drizzle-kit migrate` binary — pass — exit 0 both stages (see PROOF).
- `pnpm db:reset` (fresh, all-migrations path / CI parity) — pass — "migrations applied successfully!" exit 0.
- `pnpm test:db` — pass — 520 normal tests (27 files) + 2 workers tests, 0 fail; the 9
  `notification-schema.integration.test.ts` cases (incl. web-keys CHECK accept/reject both
  directions) all green. Per-file coverage gate did not fire.
- `turbo typecheck lint --filter=@hushbox/db --force` — pass — 2 tasks successful, cache bypassed
  (tsgo `--noEmit` clean; `eslint .` from package dir clean).

## Acceptance criteria (amended)

- Drizzle schema edit + regenerated migration in sync, no drift — MET (`db:generate` clean).
- Migration applies clean INCREMENTALLY (prior migration committed, new one applied ALONE, real
  migrate binary) — MET (PROOF above, exit 0; enum extended, CHECK present with cast).
- Fresh reset still clean — MET (`db:reset` exit 0).
- Behavior identical — CHECK still enforces web-row⟺keys both directions; all existing
  CHECK-violation tests still pass — MET (9/9 integration tests green).
- Nothing else the audit affirmed correct changed — MET.

## Deviations with reasons

None beyond the required fix. The 0058 regeneration changed the journal `when` timestamp for the
0058 entry (unavoidable with `db:generate`); migration content is otherwise identical except the
CHECK line.

## Concerns and limitations

- The device_tokens panel-GRANT carve-out concern from impl-report-1 (whether `last_seen_at`
  should be panel-readable) is unchanged and still awaiting a ruling — untouched here.

## Confidence

high — the incremental failure the auditor described was reproduced-by-construction (enum
committed as `[ios, android]` before applying 0058 alone) and the fixed migration applies exit 0
with the enum extended and the cast-based CHECK present; drift-free, fresh-reset clean, test:db
and typecheck+lint green after the last edit.
