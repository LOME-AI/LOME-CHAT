# Task 25 — impl report 2 (fix round)

## Objective

Address the three validated Minor findings from the two Task 25 audits: narrow an over-broad
privacy claim in the port comment, restore the payload validation that the original brief
ordered deleted (at the composite, the sole construction site, rather than in one transport),
and correct a stale comment in `apps/api/src/adapters/push-notify.ts`. Also correct one wrong
claim in impl report 1.

Nothing about the Task 25 type change itself was revisited — the port shape, both adapters'
by-name projection, the copy derivation, and the wire capture from report 1 all stand unchanged.

## Correction to impl report 1

`impl-report-1.md:149-151` claims:

> It is unreachable, not merely unlikely: there is no runtime value of type `PushMessage` for
> which `safeParse` would have failed on the two declared fields.

**That is wrong**, and the reviewers were right to catch it. `{ category: 'message',
conversationId: 'anything at all' }` is exactly such a value: `PushEventPayload['conversationId']`
is a bare `string` (`packages/shared/src/notifications/index.ts` types it
`z.string().regex(/^[0-9a-f]{8}-…$/i)`, and zod's inferred output type for a `.regex()`-refined
string is plain `string` — the pattern is a runtime check the type does not carry). The type
change closed the `category` half of the guard and none of the `conversationId` half.

The consequence was real, not theoretical: the deleted `safeParse` was the only server-side check
of the conversation-id *format*, so deleting it left G6's "validated on send and receive" holding
on the receive side only. Report 1's reasoning generalized from `category` (a closed enum, where
the claim is true) to the whole payload without re-checking the second field.

Report 1 is left as written, per the brief; this section is its correction of record.

## Files changed

| File | Why |
| --- | --- |
| `apps/api/src/slices/notifications/adapters/push-composite.ts` | Validates the wire payload at the sole construction site, fail-closed, covering both transports (Finding 2) |
| `apps/api/src/slices/notifications/adapters/push-composite.test.ts` | One test added, pinning the fail-closed rejection |
| `apps/api/src/slices/notifications/ports/push-sender.ts` | The over-broad clause narrowed (Finding 1) |
| `apps/api/src/adapters/push-notify.ts` | The stale `notifyEvent`-renders-copy clause corrected (Finding 3) |

No other file was touched. In particular **`push-webpush.ts` was NOT re-modified** — see the
confirmation section below.

## Finding 1 — the port comment

`ports/push-sender.ts`, the `payload` field's doc comment.

**Before:**

```
   * The generic wire payload — a category and the conversation it points at,
   * and nothing else. There is deliberately no title, body, or free-form field
   * on this message: each transport looks the words up in the shared copy table
   * from the category, exactly as the service worker does at display time, so a
   * caller has no parameter through which user-generated text could reach a
   * push service. The generic-payload law holds by construction here, not by
   * every call site remembering it.
```

**After:**

```
   * The generic wire payload — a category and the conversation it points at,
   * and nothing else. There is deliberately no title, body, or free-form text
   * field: each transport looks the words up in the shared copy table from the
   * category, exactly as the service worker does at display time. The remaining
   * field, `conversationId`, is a bare string in the type, so the composite
   * validates it against the shared conversation-id schema before dispatch —
   * that check, not the type, is what stops text riding it. The raw id itself
   * does reach FCM by design; the collapse-key note below covers that.
```

Three things changed, deliberately:

1. `free-form field` → `free-form **text** field`. The old wording covered `conversationId`,
   which is a free-form string parameter — the exact over-claim Finding 1 names.
2. The "no parameter through which user-generated text could reach a push service" sentence was
   not merely softened but **re-grounded**: it is now true, and the comment says *why* it is true
   (the composite's schema check), not that the type alone makes it so. Without the Finding 2 fix
   this sentence could not have been salvaged at all.
3. A one-clause pointer to the `collapseKey` paragraph, which still carries the full raw-id
   caveat verbatim. The caveat is not duplicated here — per the finding, that paragraph keeps it.

## Finding 2 — validation restored at the composite

Added to `push-composite.ts`, at the top of `send`, before alias derivation and before either
partition is dispatched:

```ts
    send(message: PushMessage): ResultAsync<PushDelivery, DomainError> {
      const parsed = pushEventPayloadSchema.safeParse(message.payload);
      if (!parsed.success) {
        return errAsync(
          validationError('push requires a generic {category, conversationId} payload')
        );
      }
      return fromPromise(deps.deriveCollapseKey(message.payload.conversationId), (cause) =>
        unavailableError('collapse alias derivation failed', cause)
      ).andThen((collapseKey) => fanOut(deps, { ...message, collapseKey }));
    },
```

with the reason recorded on the factory's doc comment:

```
 * It is also where the wire payload is validated, because it is the sole
 * construction site of a dispatched message and so covers both transports at
 * once. The type system fixes `category` (a closed enum) but not
 * `conversationId`, which is a bare string that reaches the push services and
 * is interpolated into a deep link on the receiving side; the schema is the
 * only check of its shape, and a rejection is fail-closed — nothing is sent.
```

Design points, each a decision rather than a default:

- **`safeParse` + `errAsync(validationError(...))`, never a throw.** Domain code returns `Result`;
  the existing `ResultAsync<PushDelivery, DomainError>` channel carries it, so no signature
  changed and no caller had to adapt. `notifyEvent` already `mapErr`s any sender error into its
  `push.delivery.degraded` warn line, so a rejection is logged with its code and swallowed
  best-effort — it cannot fail a domain transaction (G2).
- **The message string mirrors the deleted branch's shape** (`'web push requires a generic
  {category, conversationId} payload'` → `'push requires a generic {category, conversationId}
  payload'`), the word "web" dropped because the check is now transport-agnostic.
- **Placed before `deriveCollapseKey`.** The alias is an HMAC of the conversation id; deriving one
  from an unvalidated id and only then rejecting would do work on untrusted input for nothing.
- **`message` is dispatched, not `parsed.data`.** The valid path is therefore byte-identical to
  before this change — the object handed to the transports is the same object. Report 1's wire
  capture stands unmodified.

### One strengthening beyond the finding, disclosed

`pushEventPayloadSchema` is a `z.strictObject`, so it also rejects a payload carrying **unknown
keys** — the structural-typing escape hatch report 1 documented (a caller assigning a
pre-built object with an excess `preview` property). Before this change such a message was sent
with the excess property silently projected away; now it is refused outright at the composite.

This is a behavior change on a path that no production caller exercises (`notify-event.ts`
constructs the payload as a two-field literal), and it is strictly fail-closed, so I took it
rather than loosening the schema to `.pick`-style parsing. The adapters' by-name projection is
**not** now redundant: it is the defense for anything that reaches a transport without passing
the composite (the live FCM integration test does exactly that), and both anti-smuggling tests
from report 1 still exercise it directly and still pass.

### The new test, and its RED

Added to `push-composite.test.ts`:

```ts
  it('rejects a payload whose conversation id is malformed, before either transport is reached', async () => {
    const fcm = createMockPushSender();
    const webPush = createMockPushSender();
    const sender = createCompositePushSender({ fcm, webPush, deriveCollapseKey: stubDerive() });

    const result = await sender.send({
      recipients: [ios('u1', 'ios-tok'), web('u2', 'https://push/aaa')],
      payload: { category: 'message', conversationId: '../../etc/passwd' },
    });

    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(fcm.getSentMessages()).toEqual([]);
    expect(webPush.getSentMessages()).toEqual([]);
  });
```

The fixture value is a path-traversal string rather than a shapeless one, because the shared
schema's own comment names traversal as what it exists to block on the deep-link interpolation —
so the test's failure mode is the one the schema was written for.

**RED, before the implementation** (`pnpm test:watch run …/push-composite.test.ts`):

```
 ❯ src/slices/notifications/adapters/push-composite.test.ts (7 tests | 1 failed)
     × rejects a payload whose conversation id is malformed, before either transport is reached

 FAIL … Unknown Error: Called `_unsafeUnwrapErr` on an Ok

 Test Files  1 failed (1)
      Tests  1 failed | 6 passed (7)
```

Failing for the right reason and only that reason: the send returned **Ok** — the malformed id
was accepted and dispatched to both transports. Not a typo, not an import error.

**GREEN, after:**

```
 Test Files  1 passed (1)
      Tests  7 passed (7)
```

No existing test needed editing. Every push fixture in the tree already used the valid
`018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60` (checked in `push-composite.test.ts:7` and
`push-sender-factory.test.ts:42`), and every integration path builds its id from a real DB row —
so the NEEDS_CONTEXT trigger (a test whose *intent* would shift) did not fire.

## Confirmation: `push-webpush.ts` was not re-modified

No `Edit`/`Write` call in this round targeted it. Independently checked:

```
$ grep -c "safeParse\|pushEventPayloadSchema" apps/api/src/slices/notifications/adapters/push-webpush.ts
0
$ sha256sum apps/api/src/slices/notifications/adapters/push-webpush.ts
3a51331b12795463cd9fc4f1d753a1277244b972cfca2ca573422f28d92c4c7f  …/push-webpush.ts
$ git diff --stat -- apps/api/src/slices/notifications/adapters/push-webpush.ts
 1 file changed, 10 insertions(+), 10 deletions(-)
```

The 10/10 diff is report 1's change (the payload retype + the projection comment), unchanged by
this round. Neither `safeParse` nor the schema import came back.

## Finding 3 — the stale comment in `push-notify.ts`

**Before:**

```
 * Content NEVER reaches the payload — `notifyEvent` uses fixed generic
 * per-category copy (a push notification sits outside the E2E envelope) — and
 * presence rides the CALLER's fire-time snapshot, so members already watching
 * are suppressed without the notifications slice ever querying the room.
```

**After:**

```
 * Content NEVER reaches the payload — `notifyEvent` sends only the generic
 * category + conversationId pair, and each transport resolves its own fixed
 * per-category copy at the edge (a push notification sits outside the E2E
 * envelope) — and presence rides the CALLER's fire-time snapshot, so members
 * already watching are suppressed without the notifications slice ever
 * querying the room.
```

The load-bearing claim ("Content NEVER reaches the payload") was true before and stays first;
only the mechanism clause was corrected, since `notifyEvent` no longer touches copy at all
(`domain/notify-event.ts` passes the payload through; `push-fcm.ts` and the service worker each
call the shared copy table). Nothing else in this file was edited.

## Self-gate

| Command | Result |
| --- | --- |
| `npx eslint <4 changed files>` from `apps/api`, after the last edit | **pass** — `ESLINT_EXIT=0` |
| `npx tsc --noEmit -p tsconfig.json` from `apps/api` | **pass** — `TSC_EXIT=0` |
| `npx turbo lint typecheck --filter=@hushbox/api --force` | **pass** — `Tasks: 2 successful, 2 total` |
| 6 push unit suites + `push-fcm-live.integration` | **pass** — 72 passed, 1 skipped |
| 4 notifications/dev integration suites | **pass** — 104 passed |
| Whole `src/slices/notifications` under coverage | **7 failed / 384 passed / 1 skipped** — the 7 are the declared-known-red `template-html.test.ts` snapshots |

All vitest runs went through `scripts/with-env.ts` (via `pnpm test:watch` and
`npx tsx scripts/with-env.ts npx vitest`), per the brief's note about the concurrent run's env
state; a bare `npx vitest` was never used.

### Push suite counts, before and after

| Suite | Before (report 1) | After |
| --- | --- | --- |
| `push-fcm.test.ts` | 28 | 28 |
| `push-webpush.test.ts` | 9 | 9 |
| `push-composite.test.ts` | 6 | **7** |
| `push-mock.test.ts` | 4 | 4 |
| `push-sender-factory.test.ts` | 10 | 10 |
| `notify-event.test.ts` | 10 | 10 |
| **6-suite total** | **67 passed** | **68 passed** |
| `push-fcm-live.integration.test.ts` | 4 passed, 1 skipped | 4 passed, 1 skipped |
| `push-notify.integration` + `notify-event.integration` + `notifications/routes.integration` + `platform/dev/routes.integration` | 104 | 104 |

Baseline `67 passed (6)` and post-change `72 passed | 1 skipped (73)` / `104 passed (4)` were both
run in this session; the only delta is the one added test. The 104 integration tests passing is
the load-bearing check that the new validation does not reject real production sends — those
suites drive `notifyEvent` end to end over real DB rows through the real composite.

### Coverage on the changed file

`push-composite.ts`, under `push-composite.test.ts` + `push-sender-factory.test.ts`:

```
Statements   : 100% ( 19/19 )
Branches     : 100% ( 12/12 )
Functions    : 100% ( 10/10 )
Lines        : 100% ( 16/16 )
```

Both arms of the new branch are covered — the reject arm by the new test, the accept arm by the
six pre-existing composite tests. The other three changed files are comment-only.

### Reds attributed elsewhere

- **`domain/templates/template-html.test.ts` — 7 failed, 9 obsolete snapshots.** Email-template
  HTML, declared known-red in the brief and unchanged since report 1. No push code in its path;
  I touched nothing under `domain/templates/`.

No other failure appeared in any run this round.

## Acceptance criteria (the three findings)

| Finding | Verdict | Evidence |
| --- | --- | --- |
| 1 — port comment over-claims | **fixed** | Both texts quoted above; `free-form field` → `free-form text field`, and the residual claim re-grounded on the composite check that Finding 2 adds |
| 2 — deleted guard half-broke G6 | **fixed** | Validation added at `push-composite.ts` (quoted), fail-closed through the `Result` channel, covering both transports; new test verified RED (`Ok` returned) then GREEN; `push-webpush.ts` untouched (hash + grep above) |
| 3 — stale comment in `push-notify.ts` | **fixed** | Both texts quoted above; comment-only edit, nothing else in the file changed |
| Report-1 claim corrected | **done** | The "Correction to impl report 1" section above; report 1 left unedited |

## Deviations

- **`strictObject` also rejects excess keys**, so the composite is now stricter than the finding
  literally asked for (which named the malformed-`conversationId` case). Disclosed in full above.
  The alternative — parsing only the two fields loosely — would have meant not reusing the shared
  schema, which is the thing that makes this One-Implementation-Shared with the service worker's
  receive-side check.

## Concerns and limitations

- **Unchanged from report 1, and still true:** this closes smuggling of rendered *text*. The raw
  `conversationId` still reaches FCM in cleartext twice (`data.conversationId` and the Android
  `notification.tag`), deliberately, per G1's explicit carve-out. The new validation constrains
  that id's *shape*, not its visibility.
- **The composite is the sole construction site in production, not by enforcement.** Nothing in
  the type system stops a future caller from binding `createFcmPushSender` directly and bypassing
  the check; the by-name projection in each adapter is what limits the damage if one ever does.
  An arch rule pinning "the composite is the only `PushSender` the composition root binds" would
  close it structurally — out of scope here, and flagged rather than added.
- `pushEventPayloadSchema` now has a runtime caller inside `apps/api` again (the composite), which
  retires report 1's knip-adjacent concern about it having become type-only.

## Confidence

**high** — the new test was watched fail for the exact stated reason (send returned `Ok`, i.e.
the malformed id reached both transports) before the guard existed; the 104 integration tests
that drive the real composite over real conversation rows prove the guard does not reject
production traffic; and the two comment edits were checked line-by-line against the code they
describe (`push-fcm.ts`'s copy call and tag assignment, `notify-event.ts`'s payload pass-through)
rather than against the comments they replaced.
