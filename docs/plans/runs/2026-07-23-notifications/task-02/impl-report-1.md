# Task 02 — DB migrations — impl report 1

## Objective

Ship the three founder-approved schema changes (I2) with a generated Drizzle migration:
new `notification_preferences` table; `device_tokens` web-push extension + `lastSeenAt`;
`conversation_members.lastReadSeq`. Mute schema untouched.

## Files changed

- `packages/db/src/schema/notification-preferences.ts` (new) — the account-level
  prefs table.
- `packages/db/src/schema/device-tokens.ts` — `web` support: nullable `p256dh`/`auth`,
  `lastSeenAt`, web-keys CHECK.
- `packages/db/src/schema/conversation-members.ts` — durable read cursor `lastReadSeq`.
- `packages/db/src/schema/enums.ts` — `devicePlatformEnum` gains `'web'`.
- `packages/db/src/schema/index.ts` — barrel export of table + relations.
- `packages/db/src/schema/relations.ts` — `notificationPreferencesRelations` + `users` one-relation.
- `packages/db/drizzle/0058_melted_norman_osborn.sql` (new, generated) + `meta/0058_snapshot.json`,
  `meta/_journal.json` — the migration.
- `packages/db/src/schema/notification-schema.integration.test.ts` (new) — DB-level CHECK/default tests.
- `packages/db/src/schema/shape-tables.test.ts` — table added to `ALL_TABLES`; new describe blocks
  for the table, plus device_tokens/conversation_members column+check assertions.
- `packages/db/src/schema/shape-enums.test.ts` — asserts `['ios','android','web']`.
- `packages/db/src/schema/schema.integration.test.ts` — `notification_preferences` added to the
  live-DB `EXPECTED_TABLES` completeness list.

## New/changed schema objects

`notification_preferences` (id uuidv7 PK + unique userId FK; both quiet-hours CHECKs):
```
id uuid PK default uuidv7()
user_id uuid NOT NULL UNIQUE -> users.id ON DELETE cascade
global_enabled bool NOT NULL DEFAULT true
messages bool NOT NULL DEFAULT true
run_completion bool NOT NULL DEFAULT true
membership bool NOT NULL DEFAULT true
quiet_hours_start_minutes int NULL
quiet_hours_end_minutes int NULL
timezone text NULL
created_at / updated_at timestamptz NOT NULL DEFAULT now()
CHECK notification_preferences_quiet_hours_both_or_neither:
  (quiet_hours_start_minutes IS NULL) = (quiet_hours_end_minutes IS NULL)
CHECK notification_preferences_quiet_hours_timezone:
  quiet_hours_start_minutes IS NULL OR timezone IS NOT NULL
```

`device_tokens` additions:
```
p256dh text NULL
auth text NULL
last_seen_at timestamptz NOT NULL DEFAULT now()
CHECK device_tokens_web_keys_present:
  (platform = 'web') = (p256dh IS NOT NULL) AND (platform = 'web') = (auth IS NOT NULL)
```

`conversation_members` addition:
```
last_read_seq bigint NOT NULL DEFAULT 0   // 0 = nothing read; message sequences start at 1
```

`muted` is UNTOUCHED — still `muted: boolean('muted').notNull().default(false)`
(conversation-members.ts:35). No `mutedUntil`, no duration schema (a shape test now pins this).

Migration filename: **`0058_melted_norman_osborn.sql`**. It contains `ALTER TYPE
device_platform ADD VALUE 'web'`, `CREATE TABLE notification_preferences` (with both CHECKs +
unique), the three `device_tokens` ADD COLUMNs, the `conversation_members` ADD COLUMN, the prefs
FK, and the device_tokens web-keys CHECK.

## Tests added (name — behavior — criterion)

Integration (`notification-schema.integration.test.ts`, DB-enforced):
- `defaults every category on and quiet-hours off for a bare insert` — proves lazy-default row
  (globalEnabled/messages/runCompletion/membership = true; quiet-hours + tz null) — "missing row =
  defaults" + defaults criterion.
- `accepts a fully specified quiet-hours window with a timezone` — proves CHECKs do not over-reject.
- `rejects one-sided quiet hours (start set, end null)` — both-or-neither CHECK rejects.
- `rejects quiet hours without a timezone` — timezone-required CHECK rejects.
- `keeps at most one preferences row per user` — unique userId.
- `stores a web subscription with both encryption keys and stamps last_seen_at` — web row accepted;
  lastSeenAt populated.
- `stores a native token with null encryption keys` — non-web accepted keyless.
- `rejects a web row missing its encryption keys` — web-keys CHECK rejects (report-required case).
- `rejects a native row that carries encryption keys` — web-keys CHECK rejects the reverse.

Shape (in-memory over the drizzle config):
- shape-tables: `notification_preferences` describe (one-per-user; category-toggle defaults; nullable
  quiet-hours+tz; both CHECK names); device_tokens (nullable key columns; check name; last_seen_at
  default); conversation_members (`muted` left an unqualified boolean, no `muted_until`; `last_read_seq`
  bigint NOT NULL with default).
- shape-enums: `declares device platforms including web push` — enum extension.

## Self-gate

- `pnpm test:db` — pass — 520 normal tests (27 files) + 2 workers tests, 0 fail. New file contributes 9.
- `npx tsgo --noEmit` (in packages/db) — pass — exit 0.
- `npx eslint <10 owned files>` (from packages/db, after last edit) — pass — exit 0 (fixed 2
  prettier line-wrap errors in the new test file before re-running clean).
- `pnpm db:generate` after edits — "No schema changes, nothing to migrate" — schema/migration in sync
  (CI drift gate satisfied).
- `pnpm db:reset` (wipe + full migration chain on fresh DB) — "migrations applied successfully" — clean.

## Acceptance criteria

- Schema edits + generated migration committed together — MET (0058 + snapshot + journal; drift check
  clean).
- `relations()` wired; every new FK indexed — MET (notificationPreferencesRelations added; prefs
  userId FK covered by its UNIQUE; prefs userId is also the sole FK; shape-fk-indexes green).
- Schema tests cover CHECK violations (web row without keys; one-sided quiet hours; tz-less quiet
  hours), enum extension, monotonic-friendly default — MET (integration + shape tests above).
- `pnpm db:migrate` clean on reset local DB — MET.

## Deviations with reasons

1. **`notification_preferences` uses an `id` uuidv7 PK + UNIQUE `userId` FK, not a literal `userId`
   PK** as I2's shorthand ("userId PK/FK") reads. Reason: the db package enforces a hard convention —
   "uuidv7 primary keys (service_evidence the one grandfathered exception)" (packages/db/CLAUDE.md),
   pinned by shape-tables' `it.each` uuidv7 rule. The closest precedent, `preferences` (a one-row-per-
   user prefs table), uses exactly id-PK + UNIQUE userId. This preserves I2's semantics (one row per
   user, lazy default, ON DELETE cascade) and does not change the downstream contract: Task 04 keys
   reads/upserts on `userId`, which is UNIQUE, so `byUpsert` onConflict(userId) behaves identically.
2. **Edited files beyond the plan's `Files:` list**: `enums.ts` (the `'web'` extension I2 mandates),
   `relations.ts` (relations() wiring the criteria mandate), and three test files. All inside
   packages/db; the task graph makes Task 02 the sole db writer, so no concurrency conflict.

## Concerns and limitations

- **Panel carve-out (device_tokens)**: `auth` is Web Push secret material and `p256dh` is
  subscription-credential-adjacent. Because migration 0052 replaced the table-level SELECT grant to
  `admin_sql_panel` with a column-scoped GRANT, the three new columns inherit NO panel SELECT by
  construction — `auth`/`p256dh` stay unreadable (correct), and `last_seen_at` (non-secret operational
  timestamp) is also not panel-readable. I deliberately left the migration purely generated (no hand-
  added GRANT) to keep it minimal; if the ops SQL panel should read `last_seen_at`, a follow-up
  `GRANT SELECT (last_seen_at) ON device_tokens TO admin_sql_panel` is needed. Flagging for a ruling —
  not required by this task's criteria.
- **Migration mixes `ALTER TYPE ADD VALUE 'web'` with a CHECK that compares `platform = 'web'` in one
  file.** Postgres can reject using a freshly-added enum value in the same transaction. Verified GREEN
  through BOTH migrator paths: drizzle-kit `migrate` (db:reset) and the `drizzle-orm/neon-serverless`
  migrator used in the integration `beforeAll`. No split was needed on PG18; noting in case a future
  PG downgrade or migrator change surfaces it.
- **TDD note**: schema is declarative, so the CHECK behavior is proven by paired accept+reject
  integration tests (the reject tests pass only because the constraints exist; the accept tests prove
  they do not over-reject) rather than a torn-down red cycle on the generated SQL.

## Confidence

high — all scoped gates green after the final edit, migration in sync and applies clean on a wiped
DB, downstream contract (userId-keyed lookups) unaffected by the PK-shape deviation.
