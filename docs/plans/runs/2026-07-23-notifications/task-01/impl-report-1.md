# Task 01 — Shared contracts — impl report 1

## Objective

Add the notification-category and generic push-payload Zod schemas to
`@hushbox/shared`, hoist the conversation-id UUID validator out of
`apps/web/src/capacitor/provider.tsx:21` into `@hushbox/shared`, and swap that
single call site to import it. Create the exports only; add no new consumers
(Tasks 07/08 consume later). Only provider.tsx may be touched, and only for the
validator import swap.

## Files changed

- `packages/shared/src/notifications/index.ts` (new) — the three I1 exports:
  `notificationCategorySchema` (+ `NOTIFICATION_CATEGORIES` source array +
  `NotificationCategory` type), `conversationIdSchema` (hoisted UUID validator),
  `pushEventPayloadSchema` (+ `PushEventPayload` type).
- `packages/shared/src/notifications/index.test.ts` (new) — unit tests for the
  new schemas.
- `packages/shared/src/index.ts` — one barrel line
  `export * from './notifications/index.js';` (added after the `admin` export).
- `apps/web/src/capacitor/provider.tsx` — swapped the inline
  `CONVERSATION_ID_PATTERN` regex + `.test()` call for
  `conversationIdSchema.safeParse().success`, imported from `@hushbox/shared`;
  removed the now-hoisted comment (its durable content moved to the shared
  module's doc comment).

## Design note: exact-behavior hoist

`conversationIdSchema` uses the **identical** regex the provider had inline
(`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`), not
`z.uuid()`. `z.uuid()` (Zod 4) additionally enforces version/variant nibbles and
would reject some strings the old regex accepted — that would change the
accept/reject set the provider (and, later, the SW) validates against. The
acceptance requires behavior unchanged, so the regex is preserved verbatim as
the single shared implementation.

`pushEventPayloadSchema` uses `z.strictObject` (repo convention over the
deprecated `.strict()` method — see `error-codes.ts`, `param-spec.ts`) so
unknown keys are rejected: the generic-payload law (G1) cannot be bypassed by
smuggling `title`/sender text into the wire payload.

### provider.tsx line 21 — before / after

Before (const at line 21 + its use at line 58):

```
const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
...
if (conversationId && CONVERSATION_ID_PATTERN.test(conversationId)) {
```

After (const removed; import added at top; call site swapped):

```
import { conversationIdSchema } from '@hushbox/shared';
...
if (conversationId && conversationIdSchema.safeParse(conversationId).success) {
```

### New shared export signatures

```
export const NOTIFICATION_CATEGORIES = ['message', 'runCompletion', 'membership'] as const;
export const notificationCategorySchema: z.ZodEnum<...>;          // z.enum(NOTIFICATION_CATEGORIES)
export type NotificationCategory = z.infer<typeof notificationCategorySchema>;
export const conversationIdSchema: z.ZodString;                    // .regex(uuid)
export const pushEventPayloadSchema: z.ZodObject<{ category, conversationId }, strict>;
export type PushEventPayload = z.infer<typeof pushEventPayloadSchema>;
```

## Tests added (`packages/shared/src/notifications/index.test.ts`)

- `notificationCategorySchema > accepts each of the three closed categories` — valid category accept.
- `notificationCategorySchema > rejects a category outside the closed set` — reject unknown category.
- `notificationCategorySchema > enumerates exactly message, runCompletion, membership` — category exhaustiveness.
- `conversationIdSchema > accepts a well-formed uuid` — validator accept.
- `conversationIdSchema > rejects a value that is not a uuid` — validator reject.
- `conversationIdSchema > rejects a uuid carrying a path-traversal suffix` — security intent (traversal blocked).
- `pushEventPayloadSchema > accepts a generic payload of category plus conversationId` — valid payload.
- `pushEventPayloadSchema > rejects an unknown key so no user-generated text can ride along` — strict unknown-key rejection.
- `pushEventPayloadSchema > rejects a payload whose conversationId is not a uuid` — payload validates id.
- `pushEventPayloadSchema > rejects a payload whose category is outside the closed set` — payload validates category.
- `package barrel > re-exports the notification schemas` — barrel identity of all three exports.

Existing provider tests (`apps/web/src/capacitor/provider.test.ts`) act as the
regression guard for the hoist: `onNotificationTap navigates on a valid id`,
`… ignores a malformed conversationId` (path-traversal string), `… ignores tap
without conversationId`. All continue to pass after the swap.

## Self-gate (all run AFTER the last edit, forced past turbo cache; re-verified against the current tree after a mid-task restart)

- `npx turbo test --filter=@hushbox/shared --force` — **pass**. `notifications/index.test.ts` 11/11; package coverage 99.93% stmts / 99.54% branch / 100% func / 100% line, per-file gate green (Tasks: 1 successful).
- `npx turbo test --filter=@hushbox/web --force` — **pass**, exit 0 (Tasks: 1 successful). The `createConversationAndStream failed` / `modelResults is not iterable` lines in the log are expected error-path assertions inside passing tests, not failures.
- `apps/web` `vitest run src/capacitor/provider.test.ts` — **pass**, 11/11 (validator behavior preserved).
- `packages/shared` `eslint .` — **pass**, exit 0.
- `packages/shared` `eslint src/notifications/index.ts src/notifications/index.test.ts src/index.ts` — **pass**, exit 0.
- `apps/web` `eslint src/capacitor/provider.tsx` (owned file) — **pass**, exit 0.
- `@hushbox/shared` typecheck + lint (turbo, forced) — **pass**, no errors.
- `@hushbox/web` typecheck (turbo, forced) — **pass**, no errors.
- `jscpd --threshold 2` on owned files (`notifications/index.ts`, `notifications/index.test.ts`, `provider.tsx`) — **pass**, exit 0, 0 clones.

### One red NOT attributable to this task (concurrent work)

Other agents are editing this repo concurrently (git status shows churn across
`billing`/`models`/`estimate`). One full-package web gate is red on a concurrent
file, never on mine:

- `@hushbox/web` lint (turbo, forced): 1 error — `src/hooks/billing/use-prompt-budget.ts:407`
  function `usePromptBudget` complexity 11 > 10. `M` in git status; not in this
  task's ownership. My `provider.tsx` lints clean (exit 0, verified from the
  package dir). 3 of 4 turbo typecheck/lint tasks succeed; only web lint fails,
  on that concurrent file.

(An earlier `@hushbox/web` typecheck error in `use-prompt-budget.test.ts`
— `Cannot find name 'outputCharsPerTokenForTier'` — has since cleared: that file
was mid-edit by another agent and now typechecks and passes. The full `test:web`
suite is green on re-run.)

## Acceptance criteria

- Notification category schema in `@hushbox/shared` (I1) — **met**:
  `notificationCategorySchema` = `z.enum(['message','runCompletion','membership'])`
  + `NotificationCategory` type; exhaustiveness test green.
- Generic push-payload schema, strict (I1) — **met**: `pushEventPayloadSchema`
  = `z.strictObject({ category, conversationId })`; valid-payload and
  strict-unknown-key-rejection tests green.
- Conversation-id validator hoisted (I1/G6) — **met**: `conversationIdSchema`
  exported from `@hushbox/shared`; single shared implementation; accept/reject
  tests green.
- provider.tsx swapped to the hoisted validator, one call site only — **met**:
  inline regex removed, imported from `@hushbox/shared`, `.safeParse().success`;
  provider regression tests green; no gating/push-logic changes.
- No other consumers added — **met**: only the barrel export + provider.tsx
  touched; grep confirms no new imports of the new symbols elsewhere.

## Deviations

None.

## Concerns and limitations

- The barrel line I added (`export * from './notifications/index.js';`) coexists
  with a concurrent edit to `packages/shared/src/index.ts` (the estimate
  re-home). My line survived that edit and is present at index.ts:130. If the
  orchestrator sequences another shared-barrel task, note the file is being
  edited by more than one workstream.
- `@hushbox/web` full-package lint is currently red on one concurrent-work file
  (`hooks/billing/use-prompt-budget.ts:407` complexity) — not caused by this
  task. Re-run that gate once that workstream settles; my owned files are clean.

## Confidence

high — the change is a small, self-contained schema addition plus an
exact-behavior validator hoist, fully covered by new unit tests and the existing
provider regression tests; every owned-file check is green post-final-edit. The
only red signals are attributable, with evidence, to concurrent work in files
outside this task's ownership.
