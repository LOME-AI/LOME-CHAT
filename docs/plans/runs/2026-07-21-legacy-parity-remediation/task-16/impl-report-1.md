# impl-report T16 — R5: seed conversations get real titles

## Objective
Server-seeded conversations get real (legacy-parity) titles instead of the hardcoded
empty string. `seedConversationShell` accepts a `title` threaded to
`encryptTextForEpoch`; the four factory param interfaces expose it; the in-scope
`scripts/seed.ts` callers pass the legacy title values.

## Files changed
- `apps/api/src/platform/dev/factories.ts` — `seedConversationShell` now takes a
  `SeedConversationShellOptions` bag (`title` + optional `conversationId`) and encrypts
  `options.title` into `conversations.title` (was hardcoded `''`, line 176). Added
  `readonly title?: string` to all four factory param interfaces
  (`CreateDevConversationParams`, `CreateDevMultiModelConversationParams`,
  `CreateDevGroupChatParams`, `CreateDevMediaConversationParams`); each factory threads
  `params.title ?? ''`.
- `scripts/seed.ts` — new exported pure helper `screenshotConversationTitle(seedKey)`
  → `Screenshot: <suffix>`; `seedScreenshotConversations` passes it to both the solo
  (`createDevConversation`) and group (`createDevGroupChat`) branches; charlie's
  conversation passes `'charlie Conversation 1'`.
- `apps/api/src/platform/dev/factories.integration.test.ts` (test) — `seedUser` now
  returns the owner's `privateKey`; new `decryptConversationTitle` helper unwraps the
  first-epoch key from the owner member wrap and ECIES-decrypts `conversations.title`;
  new decrypting title test.
- `scripts/seed.test.ts` (test) — unit test for `screenshotConversationTitle`.

## Callers and the title each now passes
- `seedScreenshotConversations` (both solo + group branches) → `Screenshot: ${suffix}`
  derived from `spec.seedKey` (e.g. `screenshot-conv-chat` → `Screenshot: chat`,
  `screenshot-conv-group-chat` → `Screenshot: group-chat`). Parity anchor:
  `Screenshot: ${name}` (report L4645 group, L4667-4680 solo).
- charlie's conversation (`seedDevData`, `seedUUID('charlie-conv-1')`) →
  `'charlie Conversation 1'`. Parity anchor: `${personaName} Conversation ${n}`
  (`legacy/scripts/legacy_seed.ts:850`, research L14).
- Out-of-scope callers (`platform/dev/routes.ts`, `mint-admin-targets.ts`) do not pass
  a title and keep the empty default — identical to current behavior (no regression);
  they are outside T16's file ownership. See Concerns.

## Legacy title anchor (quoted)
`legacy/scripts/legacy_seed.ts:595` —
`title: encryptTextForEpoch(epochPublicKey, \`Seed Conversation ${String(convIndex + 1)}\`)`.
The factory decrypting test asserts the exact legacy value `Seed Conversation 1`.

## TDD / self-gate
- RED (factories): title assertion failed `expected '' to be 'Seed Conversation 1'` —
  right reason (title not threaded, encrypted `''`).
- GREEN (factories): `factories.integration.test.ts` — pass, 8/8.
- RED (scripts): `screenshotConversationTitle is not a function`.
- GREEN (scripts): `screenshotConversationTitle` test — pass.
- `pnpm exec tsc --noEmit` (apps/api) — pass, exit 0.
- `pnpm exec tsc --noEmit` (scripts) — pass, exit 0.
- `eslint factories.ts factories.integration.test.ts` (from apps/api) — pass, exit 0.
  (First attempt flagged `max-params` at 5 params on `seedConversationShell`; resolved
  by bundling `title`+`conversationId` into an options object, not a disable.)
- `eslint seed.ts seed.test.ts` (from scripts) — pass, exit 0.

## Acceptance criteria
1. `seedConversationShell` accepts a `title` threaded to `encryptTextForEpoch` — MET
   (`factories.ts`, `options.title` → `encryptTextForEpoch`).
2. Four factory param interfaces expose it — MET (all four now carry `readonly title?`).
3. All (in-scope) callers pass legacy title values — MET for `scripts/seed.ts`
   (screenshot + charlie). Out-of-scope callers unchanged (see Concerns).
4. A test asserts a seeded conversation carries a non-empty title — MET; the test
   decrypts the stored ciphertext and asserts it equals the legacy `Seed Conversation 1`.

## Deviations
- `seedConversationShell`'s 4th/5th params bundled into an options object instead of a
  bare positional `title` param — forced by the `max-params` (max 4) lint rule once
  `title` was added. Behavior identical; all four in-file call sites updated.

## Concerns and limitations
- **Out-of-scope callers keep empty titles.** `platform/dev/routes.ts` (four dev-only
  HTTP routes) and `mint-admin-targets.ts` call the factories without a title and now
  default to `''` — unchanged from today. Research R5 NOTES (L41) recommends those dev
  routes also get a sensible default title, but they are outside T16's stated file
  ownership. Raised for orchestrator sequencing.
- **`charlie Conversation 1` is an applied legacy *pattern*, not a byte-verbatim legacy
  string.** Charlie's discrete standalone conversation is a new-seed construct; legacy's
  generic per-persona title pattern `${personaName} Conversation ${n}` is the closest
  parity value (legacy titles were generic placeholders, not content-descriptive), so
  this is parity-faithful rather than invented content. Flagged as a load-bearing choice.
- **Pre-existing unrelated failure in `scripts/seed.test.ts`:** `BASE_TEST_PERSONAS`
  expected length 11 but is 44 (CORE + 11 worker-pool personas). The assertion is
  unchanged at HEAD and `seed-personas.ts` is unmodified in the working tree — this
  failure is outside my ownership and not caused by this task. Not fixed. Raised.

## Confidence
High — the regression fix (title threaded, decrypts to the legacy value) is proven by a
real-DB decrypting test; typecheck + lint green on all owned files.
