# T13 — R21: prove content_items constraints against real Postgres · impl-report-1

## Objective
Add real-DB rejection tests (not a name assertion) proving the `content_items`
type-consistency CHECK and the partial-unique storage-key index against local Postgres,
using the existing `expectDbError` harness and the **current** constraint names.

## Files changed
- `packages/db/src/schema/schema.integration.test.ts` — added one local helper
  (`insertContentMessage`) plus five `it` cases inside the existing
  `describe('row behavior')` block (between the messages composite-FK test and the
  `usage_records` sever test, per the research anchor). No other file touched; the
  `shape-tables.test.ts` name assertion did NOT move (real-DB cases are purely additive,
  so nothing there needed relocating).

## Tests added
1. `rejects a text content item that carries a storage key (type-consistency CHECK)` —
   text row with `storageKey` set → `expectDbError(…, /content_items_type_consistency/)`
   — covers CHECK arm (a).
2. `rejects an image content item that carries an encrypted blob (type-consistency CHECK)` —
   image row with all media fields set PLUS `encryptedBlob` → rejects — covers arm (b).
3. `rejects an image content item missing storage key, mime type, and size (type-consistency CHECK)` —
   image row with `storageKey`/`mimeType`/`sizeBytes` all null → rejects — covers arm (c).
4. `rejects a second content item reusing a non-null storage key (partial unique index)` —
   two valid image rows sharing one non-null `storageKey` →
   `expectDbError(…, /content_items_storage_key_unique/)` — covers the partial-unique index.
5. `allows many null-storage-key content items to coexist under one message (partial unique index)` —
   three text rows with null `storageKey` (positions 10/11/12) all commit; asserts count = 3
   — the partial-index NULL-coexistence positive case (mirrors legacy's 3-row case).

`storageKey` values are `${suffix}`-scoped (the index is global on `storage_key` alone), so
they can't collide with a concurrently-running invocation's rows. All new messages use
fresh sequence numbers (5–9) distinct from the existing suite's (1/3/4), so the cases are
order-independent. Cleanup rides the suite's existing user-deletion cascade
(user → conversations → epochs/messages → content_items ON DELETE CASCADE); no new teardown.

## Self-gate
- `vitest run src/schema/schema.integration.test.ts` — **pass** — 45 passed (1 file); the
  5 new cases pass by name.
- `eslint src/schema/schema.integration.test.ts` (from `packages/db`, after last edit) —
  **pass** — exit 0.
- `pnpm --filter @hushbox/db typecheck` (`tsgo --noEmit`) — **pass** — no errors.
- Full `pnpm test:db` (both vitest + workers runners) — **pass** on the initial GREEN run.

## RED-then-GREEN evidence (constraint-proving task)
The DB constraints pre-exist in the migration chain, so these are behavior-proving tests,
not new production code — a normal red-from-absent-code cycle isn't available. To prove each
`expectDbError` case is **non-vacuous** (genuinely requires the real DB rejection, not passing
for an unrelated reason), I temporarily weakened all four rejection inserts to
non-violating rows (dropped the offending `storageKey`/`encryptedBlob`; completed the missing
media fields; made the second `storageKey` distinct) and re-ran:

```
Tests  4 failed | 41 passed (45)
→ expected the statement to be rejected: expected undefined to be an instance of Error
```

All four cases failed exactly at the harness's "expected the statement to be rejected"
assertion (the row committed, nothing was caught), while the positive NULL-coexistence case
(#5) correctly still passed. The weakening was then fully reverted (file restored from a
scratchpad backup) and re-run GREEN (45 passed). This demonstrates each case catches a real
rejection carrying the right constraint name in the driver error chain.

## Constraint definitions targeted (quoted)
From `packages/db/src/schema/content-items.ts:51-72` (identical CHECK text in migration
`0038_redesigned-data-model.sql:52-63`):

```
check('content_items_type_consistency', sql`
  (content_type = 'text' AND encrypted_blob IS NOT NULL AND storage_key IS NULL
     AND mime_type IS NULL AND size_bytes IS NULL)
  OR (content_type IN ('image','audio','video') AND storage_key IS NOT NULL
     AND mime_type IS NOT NULL AND size_bytes IS NOT NULL AND encrypted_blob IS NULL)`)

uniqueIndex('content_items_storage_key_unique').on(storageKey).where(isNotNull(storageKey))
```

Constraint-name confirmation: current names are `content_items_type_consistency` and
`content_items_storage_key_unique` (schema `content-items.ts:53`, migration
`0038_redesigned-data-model.sql:422`). The audit/legacy name `content_items_storage_key_idx`
is STALE and was NOT used — tests match `/content_items_storage_key_unique/`.

## Deviations
None.

## Concerns and limitations
- The mock/valid RED demonstration required temporarily editing the committed test file
  and reverting; the final on-disk state is the GREEN version only (verified by re-run and
  `git status` showing a single modified file).

## Confidence
high — real-DB GREEN on both runners, non-vacuousness proven by the weakened-insert RED run,
constraint names verified against both schema and migration, gates clean, single-file change.
