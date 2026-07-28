# Task 25 — impl report 3 (fix round 2)

## Objective

Two items from the re-audit:

1. **(red, blocking)** The composite payload guard added in round 2 broke
   `apps/api/src/adapters/push-notify.test.ts` — a suite the round never ran. Replace its
   placeholder `conversationId: 'c1'` fixture with a real uuid in every case, without
   changing any assertion's meaning.
2. Un-export `createWebPushSender` and `createFcmPushSender` from the notifications slice
   barrel, closing (structurally, not by convention) the bypass I flagged at the end of
   report 2.

Gate for the round: **the full `pnpm test:api` package suite**, not a scoped selection.

## Corrections to impl report 2

Report 2 made two claims that are false. Report 2 is left unedited, per the brief; this is
their correction of record.

**Claim A** — `impl-report-2.md:194-197`:

> No existing test needed editing. Every push fixture in the tree already used the valid
> `018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60` (checked in `push-composite.test.ts:7` and
> `push-sender-factory.test.ts:42`) …

**False.** `apps/api/src/adapters/push-notify.test.ts` used `conversationId: 'c1'` in all six
of its cases. The check behind the claim was not a tree-wide sweep — it was two files inside
`slices/notifications/adapters/`, generalized to "the tree". The guard I added lives on a path
(`notifyEvent` → composite → transports) reached by a test file **outside** that directory, and
I never looked outside it.

**Claim B** — `impl-report-2.md:296`:

> No other failure appeared in any run this round.

**False as stated.** It is true of the runs I performed, and that is exactly the defect: no run
in round 2 covered `src/adapters/`. The sentence reported the absence of evidence as evidence of
absence. The correct statement would have been "no other failure appeared in the suites I ran,
and I did not run the package."

The root cause of both is the same: round 2's blast-radius reasoning stopped at the directory
I was editing, when the change was to a **runtime guard on a shared dispatch path**, whose blast
radius is every caller of that path.

## Files changed

| File | Why |
| --- | --- |
| `apps/api/src/adapters/push-notify.test.ts` | Placeholder conversation-id fixture replaced with a real uuid (item 1) |
| `apps/api/src/slices/notifications/index.ts` | Raw FCM / Web Push transports removed from the public barrel (item 2) |

No other file was touched. No production behavior changed by either item — item 1 is a test
fixture, item 2 removes re-exports that had no importer.

## Item 1 — the broken suite

### RED, reproduced before the fix

```
$ pnpm test:watch apps/api/src/adapters/push-notify.test.ts

 ❯ |api| src/adapters/push-notify.test.ts (6 tests | 1 failed) 7ms
     × reads preferences then device tokens for an eligible absent member 4ms (retry x1)

 FAIL  |api| src/adapters/push-notify.test.ts > createRunCompletionPushNotify >
       reads preferences then device tokens for an eligible absent member
AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times
 ❯ src/adapters/push-notify.test.ts:72:20
     70|     expect(select).toHaveBeenCalledTimes(2);
     71|     // …and the delivered device's last-seen clock is refreshed.
     72|     expect(update).toHaveBeenCalledTimes(1);
       |                    ^

 Test Files  1 failed (1)
      Tests  1 failed | 5 passed (6)
```

Exactly the auditor's chain: `'c1'` fails `pushEventPayloadSchema`, the composite returns
`Err(validation)` before either transport, `PushDelivery.deliveredTokens` is therefore never
populated, and `touchLastSeen` — the `update` spy — never fires.

### The fixture

One constant at the top of the file, used in all six cases:

```ts
/**
 * Must be a real uuid: the composite push sender validates the wire payload
 * against the shared schema and refuses to dispatch a malformed conversation
 * id, so a placeholder here would silently stop the pipeline short of `send`.
 */
const CONVERSATION_ID = '018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60';
```

The value is the same uuid every other push fixture in the tree already uses. The comment is
there because the failure mode is silent and non-local — the next author to write `'c1'` here
gets a spy-count assertion failure with nothing in it pointing at a schema.

### Every fixture changed

Six sites, all the single token `'c1'` → `CONVERSATION_ID`, nothing else on any line:

| Line (post-edit) | Case | Assertion(s) in that case | Meaning shift? |
| --- | --- | --- | --- |
| 74 | `createRunCompletionPushNotify` — reads preferences then device tokens | `select` called 2×; `update` called 1× | **No** — this is the case that was red; both assertions were written for this path and now actually reach it |
| 96 | `createRunCompletionPushNotify` — never looks up tokens when every member is suppressed | `select` called 1× | **No** — suppression happens before any payload is built; the count is unchanged |
| 117 | `createRunCompletionPushNotify` — resolves when the membership read fails | resolves `undefined` | **No** — errors out before the payload; unchanged |
| 132 | `createChatMessagePushNotify` — reads members, preferences, then tokens | resolves `undefined`; `select` called 3× | **No** — see the latency note below |
| 144 | `createChatMessagePushNotify` — excludes a link-guest (null userId) | resolves `undefined`; `select` called 1× | **No** — no candidate survives, so no payload is built |
| 160 | `createChatMessagePushNotify` — resolves when the member read fails | resolves `undefined` | **No** — rejects before the payload |

The three `createChatMessagePushNotify` cases passed on `'c1'` and pass on the uuid, but the
brief is right that leaving them was leaving a trap: the case at line 132 stops counting at the
third `select`, which is the token lookup — one step **before** `send`. It asserted a pipeline
that, from that point on, was being rejected at the composite and it could not tell. Any future
assertion added past that point (a delivery count, a `touchLastSeen` write — precisely what the
run-completion case already does) would have failed for a reason unrelated to what it tested.
Same fixture, same latency, same class of defect.

No assertion text, count, or intent changed anywhere in the file; the diff is six identifiers
plus the constant and its comment.

### GREEN, after

```
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

## Item 2 — the barrel un-export

### Verification that nothing outside `adapters/` imports either sender

Required by the brief before removing. Run at repo root, over every `.ts`/`.tsx`/`.js`, with
`node_modules` and the slice's own `adapters/` directory excluded:

```
$ grep -rn "createWebPushSender\|createFcmPushSender" \
    --include='*.ts' --include='*.tsx' --include='*.js' . \
  | grep -v node_modules | grep -v "slices/notifications/adapters/"

packages/config/arch/rules/no-evidence-from-mocked-seam.rule.test.ts:25:        "  const sender = createFcmPushSender({ projectId: 'p', fetchImpl, db, isCI: true });",
packages/config/arch/rules/no-evidence-from-mocked-seam.rule.test.ts:127:        '  const sender = createFcmPushSender({',
apps/api/src/slices/notifications/index.ts:33:export { createWebPushSender } from './adapters/push-webpush.js';
apps/api/src/slices/notifications/index.ts:51:export { createFcmPushSender } from './adapters/push-fcm.js';
```

Four hits, zero importers:

- The two `packages/config` hits are **string literals**, not code. They are lines of a
  synthetic source file that an arch-rule unit test writes into an in-memory ts-morph project
  as a fixture (read at `no-evidence-from-mocked-seam.rule.test.ts:18-32` and `:120-134` —
  each sits inside a `[…].join('\n')` array of quoted lines). Nothing is imported or executed;
  the rule under test only reads the text. Deleting the barrel exports cannot affect them.
- The two remaining hits are the barrel re-exports themselves.

Inside `slices/notifications/adapters/`, the only real consumer is `push-sender-factory.ts:3-4`
(which composes both into the composite) plus each adapter's own colocated test. That is the
construction site the standing amendment names, and it is unaffected.

I also confirmed the removal is consistent with the run's standing amendment
(`plan.md:1437-1442`, "Alias-stamping is composite-only"). That amendment *records* the barrel
as exporting the raw factories; its **rule** is "no production code may construct or call a raw
transport sender directly — the factory/composite is the only construction site." Removing the
exports strengthens that rule rather than contradicting it, and the parenthetical it carries
("Task 06 needs the sibling mock export") refers to `createMockPushSender`, which stays
exported (`index.ts:49`) and is untouched.

### What was removed

`apps/api/src/slices/notifications/index.ts`, four export lines, replaced by a comment where the
second pair sat:

```ts
/**
 * The raw FCM and Web Push transports are deliberately NOT exported. Only the
 * composite sender derives and stamps the per-conversation collapse alias and
 * validates the wire payload, so a direct binding of either transport would
 * bypass both. Keeping them inside the slice makes that bypass unreachable
 * across the boundary rather than merely discouraged.
 */
```

`createCompositePushSender`, `createPushSenderFromEnv`, `createMockPushSender`, the
`PushSender`/`PushMessage`/`PushDelivery` types and everything else on the barrel are unchanged.

### Disclosed: I also removed the two config *type* exports

The brief named `index.ts:33,51` — the two value exports. I removed the adjacent
`export type { WebPushSenderConfig }` (`:34`) and `export type { FcmPushSenderConfig }` (`:52`)
as well.

Reason: they are the parameter types of the factories I just made unreachable, so after the
removal they name the argument of a function no external caller can call — orphaned by my own
change, which AGENT-RULES requires cleaning up, and two new dead exports for knip otherwise.
Verified by the same grep that they have no other reference anywhere outside their declaring
adapter:

```
$ grep -rn "WebPushSenderConfig\|FcmPushSenderConfig" --include='*.ts' --include='*.tsx' . | grep -v node_modules
apps/api/src/slices/notifications/index.ts:34:export type { WebPushSenderConfig } from './adapters/push-webpush.js';
apps/api/src/slices/notifications/adapters/push-webpush.ts:25:export interface WebPushSenderConfig {
apps/api/src/slices/notifications/adapters/push-webpush.ts:41:export function createWebPushSender(config: WebPushSenderConfig): PushSender {
apps/api/src/slices/notifications/index.ts:52:export type { FcmPushSenderConfig } from './adapters/push-fcm.js';
apps/api/src/slices/notifications/adapters/push-fcm.ts:182:export interface FcmPushSenderConfig {
apps/api/src/slices/notifications/adapters/push-fcm.ts:207:export function createFcmPushSender(config: FcmPushSenderConfig): PushSender {
```

Both interfaces stay exported from their own adapter modules (unchanged); only the barrel
re-export is gone. A type export could never have been the bypass, so this is tidiness, not
security — flagged rather than folded in silently.

### No test added, and why

This item is a deletion of two re-exports with no importer. The compiler is the check that
proves it: `tsc --noEmit` over the package resolves every import in `apps/api`, and a suite of
6460 tests exercises the composition root — both green below. A test asserting that a barrel
does *not* export a name would pin the absence of a line rather than a behavior, and the
structural property is already carried by the existing boundaries lint (nothing outside the
slice may reach past `index.ts`). The brief chose this removal precisely as the cheaper
alternative to a new arch rule; adding an assertion test would re-import the cost it avoided.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test:watch apps/api/src/adapters/push-notify.test.ts` (RED, pre-fix) | **1 failed / 5 passed (6)** — the expected failure, quoted above |
| `pnpm test:watch apps/api/src/adapters/push-notify.test.ts` (GREEN, post-fix) | **pass** — 6 passed (6) |
| `npx tsc --noEmit -p tsconfig.json` from `apps/api`, after the last edit | **pass** — `TSC_EXIT=0` |
| `npx eslint src/adapters/push-notify.test.ts src/slices/notifications/index.ts` from `apps/api`, after the last edit | **pass** — `ESLINT_EXIT=0` |
| **`pnpm test:api` (full package, coverage enabled)** | **1 file failed / 469 passed / 1 skipped (471); 7 tests failed / 6460 passed / 3 skipped (6470)** — see attribution |

All vitest runs went through `scripts/with-env.ts` (`pnpm test:watch` and `pnpm test:api` both
route through it); a bare `npx vitest` was never used.

### Full `pnpm test:api` — every failure attributed

The run reported exactly one failing test **file**:

```
 Test Files  1 failed | 469 passed | 1 skipped (471)
      Tests  7 failed | 6460 passed | 3 skipped (6470)
   Duration  265.61s
```

```
$ grep -o "FAIL .* src/[^ ]*\.ts" /tmp/hb_test_api.log | sed 's/.*src/src/' | sort -u
src/slices/notifications/domain/templates/template-html.test.ts
```

| Failure | Attribution |
| --- | --- |
| `src/slices/notifications/domain/templates/template-html.test.ts` — 7 snapshots failed, 9 obsolete | **Not mine — declared known-red in the brief.** Email-template HTML. The diff on every one is a single removed line, the Merriweather `<link href="https://fonts.googleapis.com/css2?…">` in `<head>`; the snapshots predate that removal. Nothing under `domain/templates/` was touched in any of my three rounds, and no push code is in its path. |

Nothing else failed. In particular the other declared known-reds did **not** reproduce in this
run: no `coverage/.tmp` ENOENT (grepped, zero hits), and `chat/routes.integration.test.ts`
passed. `scripts/` and `knip` are outside this package and were not exercised by `test:api`.
Coverage ran (`Coverage enabled v8`) and reported no threshold violation.

The 469 passing files include every push suite — `push-notify.test.ts`,
`push-notify.integration.test.ts`, `push-composite.test.ts`, `push-fcm.test.ts`,
`push-webpush.test.ts`, `push-mock.test.ts`, `push-sender-factory.test.ts`,
`push-fcm-live.integration.test.ts`, the three `webpush/` suites, and
`conversations/adapters/push-membership-reader.test.ts` — so round 2's guard is now confirmed
across the whole package rather than one directory of it.

## Acceptance criteria (this round's two items)

| Item | Verdict | Evidence |
| --- | --- | --- |
| 1 — `push-notify.test.ts` fixture | **met** | RED quoted verbatim before the change, GREEN after; all six sites changed and tabulated with the no-meaning-shift argument per case; full package suite green apart from the declared known-red |
| 1b — correct report 2's two false claims | **met** | "Corrections to impl report 2" above, with the root cause; report 2 left unedited |
| 2 — un-export the two raw senders | **met** | Grep output above proves zero importers outside `adapters/` (the two non-barrel hits are string fixtures inside an arch-rule test, shown in context); exports removed; typecheck and 6460 tests green |
| Gate — full `pnpm test:api` | **met** | Run in full under `scripts/with-env.ts`; every failure attributed above |

## Deviations

- **Removed two more lines than the brief named** — the `WebPushSenderConfig` /
  `FcmPushSenderConfig` type re-exports adjacent to the value exports. Rationale, grep evidence,
  and the note that a type export was never the bypass are in the item-2 section.
- **No new test for item 2**, with the reasoning stated above. If the auditor disagrees, the
  cheapest form is a one-line assertion in an existing notifications suite that the barrel's
  export list omits both names — say so and I will add it.

## Concerns and limitations

- **The composite payload guard now has a proven blast radius, and it is wider than the
  notifications slice.** `apps/api/src/adapters/push-notify.test.ts` is the second file to hit
  it and it lives outside the slice. Any future test or fixture that drives `notifyEvent` with a
  non-uuid conversation id will fail silently-at-a-distance in the same way — the symptom is a
  missing downstream call, never a validation message. The comment I added on `CONVERSATION_ID`
  covers this one file only; nothing enforces it generally.
- **Item 2 closes the bypass across the slice boundary, not inside it.** Code inside
  `slices/notifications/adapters/` can still construct a raw transport directly (as
  `push-sender-factory.ts` legitimately does). That was already true and is the point of having
  a factory; the arch rule I floated in report 2 would be the only thing to also pin the
  *inside* — still out of scope, still flagged rather than added.
- **`template-html.test.ts` is a real red on `main`-adjacent code**, not a flake: the obsolete
  snapshots and the removed font `<link>` say a Merriweather removal shipped without
  `-u`. Declared not-mine by the brief; recording it because it will keep failing every
  `pnpm test:api` until whoever owns it updates the snapshots.

## Confidence

**high** for both items. Item 1's failure was reproduced verbatim before the fix and the fix
was confirmed by the whole package rather than by the file — the exact gate whose absence caused
this round. Item 2's safety rests on a grep whose only non-barrel hits I opened and read, and on
a clean typecheck of the package that resolves every import against the reduced barrel.

The residual uncertainty is not in either change; it is that `pnpm test:api` covers `apps/api`
and nothing else, while the barrel is in principle importable from other packages. The grep was
repo-wide and found no such importer, so this is belt-and-braces rather than an open question.
