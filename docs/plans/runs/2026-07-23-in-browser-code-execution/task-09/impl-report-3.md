# T9 — dev-only conversation-seed title pass-through (impl report 3)

## Objective

Unblock the T9 Maestro flow (`14-document-renders.yaml`), which taps the seeded
conversation's chat row by the text `Mobile render proof`. The seed sent no title,
the dev route's body schema had no `title` field, and `createDevConversation`
defaults `title: ''` → the row renders the empty-title placeholder ("Decrypting…"),
leaving no unique tappable text. Give the dev-only seed path an optional title and
have the mobile seed set the exact string the flow selects on. Test-infra only; no
production behavior changes.

## Files changed

- `apps/api/src/platform/dev/routes.ts` — added an optional `title: z.string().optional()`
  to `conversationBodySchema`, and forward it to `createDevConversation` in
  `seedConversationWork` via the same `...(x === undefined ? {} : { x })` idiom the
  siblings use (exactOptionalPropertyTypes-safe). `createDevConversation` already
  accepted a `title` param; nothing else about the route changed. The route keeps its
  `routeClass('dev-only')` first handler untouched (404 in production).
- `scripts/mobile-test.ts` — `documentSeedPayload()` now includes
  `title: 'Mobile render proof'`, matching the flow's chat-row text selector.
- `apps/api/src/platform/dev/routes.integration.test.ts` — extended the `@hushbox/crypto`
  import with `decryptTextFromEpoch`/`unwrapEpochKey`; `seedUser` now also returns the
  owner `privateKey` (additive — existing `{ id, email }` destructures unaffected); added
  a local `decryptConversationTitle` helper (mirrors the factory test's, the only way to
  assert the encrypted title's plaintext); added two `POST /dev/conversation` tests.
- `scripts/mobile-test.test.ts` — the payload-shape test now also asserts
  `parsed.title === 'Mobile render proof'`.

## Tests added

- `forwards an optional title to the seeded conversation` — POST with
  `title: 'Mobile render proof'` → decrypted `conversations.title` equals it. Covers the
  new behavior (route forwards the field).
- `leaves the conversation untitled when no title is given` — POST without title →
  decrypted title is `''`. Back-compat guard (documents existing default).
- `mobile-test.test.ts` payload test — extended to assert the seed carries the exact
  title text the flow taps.

## Self-gate

- `npx turbo typecheck --filter=@hushbox/api` — **pass** (typecheck task successful).
- `pnpm test:watch run apps/api/.../routes.integration.test.ts` — **pass**, 64/64.
- `npx vitest run scripts/mobile-test.test.ts` — **pass**, 144/144.
- `eslint` on owned files after last edit — **exit 0**: `apps/api/src/platform/dev/routes.ts`
  + `routes.integration.test.ts` (run from `apps/api`); `scripts/mobile-test.ts` +
  `mobile-test.test.ts` (run from `scripts`).
- `turbo lint --filter=@hushbox/api` — **fail (19 errors)**, but every error is in a file
  this task did not touch: `slices/models/domain/estimate-run.test.ts`,
  `slices/models/domain/trial-smart-model-candidates.test.ts`,
  `slices/workflows/engine/interpreter.test.ts`,
  `slices/workflows/engine/smart-model.integration.test.ts` (all prettier/unicorn). These
  are the concurrent apps/api churn the brief flagged (all show `M` in `git status`,
  none are my files). Unattributable to this change; not fixed (out of ownership).

## Acceptance criteria

- **Dev route accepts an optional title and forwards it** — met (schema field +
  pass-through; integration test decrypts to the supplied value).
- **Route stays dev-only (404 in production)** — met (`routeClass('dev-only')` unchanged;
  the file's existing dev-only class test still passes in the 64/64 run).
- **Seed sets `Mobile render proof`** — met (`documentSeedPayload()` carries it;
  unit test asserts the exact string).
- **No production route/schema/behavior change** — met (only the dev-only seed schema and
  the dev seed script changed; title is only ever set via the dev-only route).
- **Back-compat** — met (omitted title still yields an untitled conversation; existing
  empty-conversation and payload tests still green).

## Deviations

None.

## Concerns and limitations

- `turbo lint --filter=@hushbox/api` is red from concurrent work in the models/workflows
  slices (19 prettier/unicorn errors), not from this change. Raised for orchestration; the
  api lint gate will not pass until that concurrent churn is formatted.
- No Android emulator here, so no live Maestro run. This lands the seed-title dependency
  Concern 1 of impl-report-2 named; the emulator run remains the true end-to-end gate.

## Confidence

high — the change is a minimal optional-field pass-through on a dev-only path, proven by
a decrypt-based integration test (RED→GREEN) and the updated seed-shape unit test; owned
files are eslint/typecheck clean. The only red is pre-existing concurrent-work lint, fully
attributed.
