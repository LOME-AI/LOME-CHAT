# T19 impl-report-1 — R23 dev/seed parity

## Objective
Restore two lost dev-seed behaviors (finding R23):
- **R23.a** — the bulk per-persona sample-data generator, wired to the dead
  `hasSampleData` field.
- **R23.b** — add the missing `share:create:user:ratelimit:*` reset to
  `DELETE /dev/usage-rate-limits`.

## Files changed
- `apps/api/src/platform/dev/redis-resets.ts` — add `'share:create:user:ratelimit:*'`
  to the `resetUsageRateLimits` prefix array (R23.b).
- `apps/api/src/platform/dev/redis-resets.test.ts` — new `resetUsageRateLimits` describe:
  proves the share-create prefix is cleared + the existing usage prefixes still are.
- `scripts/lib/seed-personas.ts` — add `sampleConversationCount: number` to the
  `DevPersona` interface; set it on all three `DEV_PERSONAS` (alice 150, bob 3,
  charlie 3 — the legacy `DEV_PERSONAS.conversationCount` values).
- `scripts/seed.ts` — restore the bulk generator: `buildPersonaSampleConversations`
  (pure), `SEARCH_CONVERSATION_MESSAGES`, `buildGenericSampleMessages`,
  `personasWithSampleData` (the `hasSampleData` gate), and `seedPersonaSampleData`
  (persists via `createDevConversation`); wire the gated loop into `seedDevData`
  after `mintAll`; add `sampleConversationCount` to `ADMIN_TARGET_PERSONA`; extend the
  `seed[dev]` log line.

## Tests added (RED→GREEN verified)
- `redis-resets.test.ts` › `resetUsageRateLimits` › *clears the authenticated
  share-create per-caller rate-limit bucket* — R23.b; failed RED (prefix absent),
  green after the one-line add.
- `redis-resets.test.ts` › `resetUsageRateLimits` › *clears the chat-stream and media
  usage rate-limit buckets* — guards the pre-existing prefixes against regression.
- `seed.test.ts` › `buildPersonaSampleConversations` (6 tests) — scale (alice→150,
  bob→3), the `index===2` `'Quantum Computing Research'` search carve-out + its 4 canned
  messages, generic `3 + (index % 3)` message count, user/ai alternation, generic content
  format (`bob message 1-1`), deterministic `seedUUID` ids. Covers R23.a criterion 3.
- `seed.test.ts` › `personasWithSampleData` (2 tests) — selects only `hasSampleData`
  personas (alice, count 150) and excludes bob/charlie/mallory. Proves `hasSampleData`
  is now read (criterion 1) and non-sample personas get no bulk data.

All new tests watched fail first for the right reason (missing export / missing prefix),
then pass.

## Self-gate
- `vitest run scripts/seed.test.ts apps/api/src/platform/dev/redis-resets.test.ts` —
  28 passed, **1 pre-existing foreign failure** (`BASE_TEST_PERSONAS` length 11 vs 44,
  see below).
- `vitest run scripts/seed-run.test.ts` — pass (10) — drives `runSeed()` with a mocked
  `createDevConversation`, so the new `seedDevData`→`seedPersonaSampleData` path (alice
  ×150) is exercised.
- `vitest run scripts/lib/seed-personas.test.ts` — pass (27) — the new interface field
  doesn't disturb roster assertions.
- ESLint (from package dirs) on all 5 owned files after the last edit — exit 0.
- `turbo typecheck --filter=@hushbox/api --filter=@hushbox/scripts --force` — 2/2 pass.
- Coverage `seed.ts` (foreign failing test name-filtered out) — **99.31% lines /
  97.82% branch / 97.82% funcs**, only uncovered line is pre-existing `seedPublicStats`
  line 650 (not my code). New code fully covered.

## Acceptance criteria
1. **Bulk generator wired to `hasSampleData` (field now read, not dead)** — MET.
   `personasWithSampleData(devRoster)` gates the generator loop in `seedDevData`; unit
   test pins alice-only selection. Parity: legacy `createPersonaSampleData`
   (`legacy/scripts/legacy_seed.ts:802-886`, gated call `:1456-1483`), alice
   `hasSampleData:true, conversationCount:150` (`:162-169`). Reproduced: 2 projects
   are the one deliberate deviation (see below); conversations titled
   `${persona} Conversation ${n}` with the `convIndex===2 → 'Quantum Computing Research'`
   search carve-out (`:848-873`, `SEARCH_MESSAGES` `:699-728`), generic messages
   `3 + (index % 3)` alternating user/ai with content `${persona} message ${c}-${m}`
   (`createGenericConversationMessages` `:767-800`), deterministic
   `seedUUID('${persona}-conv-${n}')` ids (`:834`).
2. **`DELETE /dev/usage-rate-limits` clears `share:create:user:ratelimit:*`** — MET.
   Exact template read from the Redis key registry
   `apps/api/src/slices/conversations/adapters/rate-limit.ts:34`
   (`shareCreateRateLimit.buildKey → 'share:create:user:ratelimit:${callerId}'`), matched
   with the `*` wildcard the sibling prefixes already use. This makes the
   `e2e/helpers/auth.ts:174-179` `clearUsageRateLimits` claim true.
3. **Tests: reset covers share-create key; generator produces expected scale** — MET
   (see tests above).

## Deviations with reasons
- **Projects not seeded.** Legacy `createPersonaSampleData` also built 2 per-persona
  "projects". The redesigned schema has no projects table
  (`docs/ARCHITECTURE.md` §Data model lists none), and `research/legacy-devseed.md`
  R23.a explicitly scopes the restoration to "conversations + messages, optionally
  projects... to the extent those exist in the new schema." Projects don't exist, so
  they're omitted — a schema-driven deviation, not a parity gap.
- **`createDevConversation` (per-conversation settlement) vs legacy batch insert.**
  Legacy built plain arrays for one batch insert; the new sanctioned primitive is the
  published `createDevConversation` factory (named as the insertion primitive in
  `research/legacy-devseed.md` R23.a NOTES). This means alice's 150 conversations are
  150 sequential `runSettlement` transactions in `pnpm db:seed` (dev-only path). The
  parity anchor is the *scale of data that exists* (150 conversations), which is
  reproduced; the insert mechanism differs by design. See Concerns.

## Working around the foreign `seed-personas.ts` state
The brief warned `BASE_TEST_PERSONAS` is 44 entries (roster + worker-pool) with a
pre-existing failing `scripts/seed.test.ts` test asserting length 11. Confirmed at the
baseline: at session start `git status` showed `seed-personas.ts` with **no** uncommitted
diff (the 44-entry roster is committed at HEAD `92785bc4`), and
`vitest run scripts/seed.test.ts` failed exactly that one test *before* I touched
anything. I did **not** revert the roster and did **not** touch the length-11 test — both
are another workstream's. My R23.a change is orthogonal: it edits the **`DevPersona`**
interface + `DEV_PERSONAS` (the dev roster), not the `BaseTestPersona`/
`WORKER_POOL_TEST_PERSONAS` machinery the foreign change owns. No conflict arose. The
length-11 failure persists identically after my change (it suppresses the vitest coverage
report for `seed.test.ts`, which is why coverage was measured with that test name-filtered
out).

## Concerns and limitations
- `seed.test.ts` still has the one foreign failing test (`BASE_TEST_PERSONAS` 11≠44). It
  is a green-blocker for the scripts suite and for the `seed.ts` coverage report, owned by
  the roster/worker-pool workstream — not fixable within T19's bounds.
- Dev-seed runtime: alice's 150 sequential settlement transactions add real wall-time to
  `pnpm db:seed` (dev/e2e-prepare only, never production — guarded by
  `assertLocalDatabaseUrl`). Legacy accepted the same 150-conversation scale via a faster
  batch path; a bulk factory doesn't exist in the new surface and building one is out of
  T19 scope.

## Confidence
High — parity behaviors reproduced against opened legacy source (G1), TDD RED→GREEN
observed, all owned-file gates green, new code 99%+ covered; the sole red is the
independently-confirmed foreign test.
