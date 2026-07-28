# Task 24 — impl report 1

**STATUS: NEEDS_CONTEXT.** Finding A is implemented and green. **Finding B is NOT
implemented** — it is unimplementable as specified, and the criterion that forbids editing
existing tests is the criterion that catches it. Evidence below is empirical, not read-based.

## Objective

Close the two generic-payload-law gaps found by the privacy audit: (A) correct a wrong
comment on a privacy boundary; (B) add fail-closed `pushEventPayloadSchema` validation to
the FCM adapter, mirroring the web adapter.

## Files changed

- `apps/api/src/slices/notifications/ports/push-sender.ts` — corrected the `collapseKey`
  doc comment (Finding A). Comment only; no code, no exports, no types touched.

`apps/api/src/slices/notifications/adapters/push-fcm.ts` and `push-fcm.test.ts` are
**unchanged** — see Finding B below. The two variants I ran were experiments, reverted
byte-exactly (verified: the file's imports and `send()` body match the pre-experiment read,
and the suite returned to its exact baseline of 25 passed).

## Finding A — the comment correction

**Old** (`ports/push-sender.ts:36-42`):

```ts
  /**
   * The per-conversation collapse alias (a truncated HMAC of the
   * conversationId, never the raw id — the generic-payload law). The composite
   * sender derives and stamps it before dispatch; each transport applies it as
   * its collapse identity (FCM `collapse_key` + notification `tag`, Web Push
   * `Topic`). Absent when the message is not conversation-scoped.
   */
```

**New:**

```ts
  /**
   * The per-conversation collapse alias (a truncated HMAC of the
   * conversationId, never the raw id — the generic-payload law). The composite
   * sender derives and stamps it before dispatch; each transport applies it as
   * its collapse identity, and nowhere else: the FCM `collapse_key`, the APNs
   * `apns-collapse-id` header, and the Web Push `Topic` header. Absent when the
   * message is not conversation-scoped.
   *
   * The Android notification `tag` is deliberately NOT this alias — it carries
   * the raw conversationId, and so does the FCM data payload, so the raw id
   * does reach FCM on the native path by design. The alias protects the
   * push-service-visible collapse fields, which is what the Web Push transport
   * (whose payload is encrypted) would otherwise leak. The FCM adapter carries
   * the reasoning where it sets the tag.
   */
```

Each claim was verified against the code, not against the old comment:

| Claim | Evidence |
| --- | --- |
| alias → FCM `collapse_key` | `push-fcm.ts:236` `collapse_key: collapse` |
| alias → APNs `apns-collapse-id` (the old comment omitted this entirely) | `push-fcm.ts:239` `apns: { headers: { 'apns-collapse-id': collapse } }` |
| alias → Web Push `Topic` | `push-webpush.ts:65` `{ topic: message.collapseKey }` |
| Android notification `tag` = **raw** conversationId, not the alias | `push-fcm.ts:224` `const shadeTag = message.data?.['conversationId'];` → `:237` `notification: { tag: shadeTag }` |
| raw id also reaches FCM in the data payload | `push-fcm.ts:231` forwards `message.data` verbatim; `notify-event.ts:119` sets `data: { category, conversationId }` |
| the domain rationale lives in the adapter, referenced not duplicated | `push-fcm.ts:218-223`; consistent with `collapse-alias.ts:9-11` |

Referenced by module role ("the FCM adapter"), not by file path, per the
never-hardcode-paths documentation rule.

No test accompanies this change: it alters no behavior, and the plan scopes this file
"comment only". The Iron Law binds production code; a doc comment carries none.

## Finding B — NOT IMPLEMENTED (blocked by an internal contradiction)

The brief's stated safety premise is:

> the composite hands BOTH partitions the SAME `PushMessage`, and `push-webpush.ts:56-61`
> already requires a valid generic payload. So any message that reaches FCM in production
> today already satisfies the schema.

**That premise is false for the code as written.** The composite does not hand both
partitions the same message unconditionally — `push-composite.ts:60-62` short-circuits a
partition with zero targets *before* calling its sender:

```ts
function dispatch(sender, message, targets) {
  if (targets.length === 0) {
    return okAsync({ successCount: 0, failureCount: 0, deliveredTokens: [], deadTokens: [] });
  }
  return sender.send({ ...message, recipients: targets });
}
```

and `push-webpush.ts:53-55` returns early on an empty web partition *before* its
`safeParse`. So a **native-only** message (a user with only Android/iOS devices — the
common case) never passes through the web validation at all. The web adapter is not a gate
in front of FCM; the two paths are independent. The invariant holds today only because
`notify-event.ts:119` is the single caller and builds a valid payload — which is exactly
the convention-not-structure gap Finding B set out to close, and exactly why the guard
cannot be assumed already satisfied.

Two consumers pass `data` that does **not** satisfy `pushEventPayloadSchema`:

1. **`push-fcm.test.ts`** — its shared fixture (`:37-41`) has **no `data` key at all**, and
   the three tests that do set data use `data: { conversationId: 'conv-1' }` (`:172`,
   `:188`, `:210`) — no `category`, and `'conv-1'` is not a UUID.
2. **`push-fcm-live.integration.test.ts:183-186`** — the CI-gated **live send to Google**
   (Task 18's evidence proof) sends `{ recipients, title, body }` with **no `data`**. This
   is the unaccounted caller the brief's NEEDS_CONTEXT trigger anticipated; it is also a
   completed, audited-clean task's file.

### Empirical proof (both variants run, then reverted)

Baseline, before any edit:

```
 Test Files  1 passed (1)
      Tests  25 passed (25)
```

**Variant 1 — faithful mirror of `push-webpush.ts:56-61`** (validate `message.data`
unconditionally, after the empty-recipients early return):

```
     × exchanges a signed JWT for an access token before sending
     × posts each token to the project send endpoint with the bearer token
     × asks FCM to validate without delivering when configured validate-only
     × omits the validate-only key entirely from an ordinary send
     × includes the data payload when provided
     × collapses on the derived alias, never the raw conversation id
     × tags the shade entry with the same conversation id the data payload carries
     × omits the notification tag when the message carries no conversation id
     × omits the collapse fields when no alias is set
     × reports an UNREGISTERED token as dead and leaves a delivered one alone
     × counts a non-dead failure without marking the token for pruning
     × does not prune when a failed response body is not JSON
     × counts a send that rejects at the transport layer as a failure
     × reuses the cached access token across sends
     × maps an OAuth exchange failure to an unavailable error
⎯⎯⎯⎯⎯⎯ Failed Tests 15 ⎯⎯⎯⎯⎯⎯⎯
```

**15 of 25 existing tests fail.** (Plus the live integration test, which does not run in
this environment but sends no `data` and would fail the same way.)

**Variant 2 — the weakest change that still satisfies "no FCM request for an invalid
payload"** (validate only when `data !== undefined`, so a data-less message is exempt):

```
     × includes the data payload when provided
     × collapses on the derived alias, never the raw conversation id
     × tags the shade entry with the same conversation id the data payload carries
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯
 Test Files  1 failed (1)
      Tests  3 failed | 22 passed (25)
```

Still 3 failures — and variant 2 is strictly weaker than the criterion asks for
(a `data`-less message would sail through, so it does not make the law structural).

After revert:

```
 Test Files  1 passed (1)
      Tests  25 passed (25)
```

### The contradiction

These two criteria cannot both hold:

- "`push-fcm.ts` validates `message.data` against `pushEventPayloadSchema` and returns a
  `validation` DomainError on failure … No FCM request is issued for an invalid payload."
- "Every existing push test still passes unchanged — if one needs editing, that is a signal
  the change altered behavior; stop and report rather than adjusting the test."

There is no implementation satisfying the first that also satisfies the second. Per the
brief's explicit instruction and the plan's own criterion, I stopped rather than editing
tests to fit.

**My read of what the signal actually means:** the change does not alter *production*
behavior — `notify-event.ts` is the only production caller and its payload is valid. What
the failures reveal is that the FCM adapter's tests were written against a contract that
never required `data`, because no validation existed. Making the law structural therefore
*does* require updating those fixtures. That is a legitimate consequence of tightening a
contract, not evidence of a behavior regression — but it is not my call to make, because
the criterion forbidding it is explicit and the blast radius includes another task's
audited live-proof file.

### What I need ruled

1. **May the `push-fcm.test.ts` fixtures be updated** to carry a valid
   `{ category, conversationId }` payload (a UUID instead of `'conv-1'`)? This is ~16 test
   sites and would strengthen the fixtures to match production. Mostly mechanical, with one
   caveat: it is not purely a fixture-literal swap. `:226-228` asserts the shade tag against
   the literal `'conv-1'` (`toBe('conv-1')`), so those assertion values move too — the
   behavioral assertions (tag equals the data payload's id, and is not the alias) stay
   intact, but the expected strings change. If yes, Finding B is a short, clean task.
2. **May `push-fcm-live.integration.test.ts:183-186` gain a `data` field?** It is Task 18's
   audited file and outside my declared Files list. Without this, the live CI proof against
   Google breaks. This one is unavoidable — it is not a fixture-tidiness question.
3. Confirm the intent is the **strict** guard (data required, variant 1), not the weaker
   data-present-only guard (variant 2), which leaves the hole open.

Note the plan's Files list (`push-fcm.ts`, `push-fcm.test.ts`) does not include the live
integration test, so the task was scoped without accounting for it.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test:watch apps/api/src/slices/notifications/adapters/push-fcm.test.ts` | pass — 25/25 (baseline restored after experiments) |
| `turbo lint typecheck --filter=@hushbox/api --force` | **pass** — `EXIT=0`, `Tasks: 2 successful, 2 total`, 0 cached (forced), 3m16s |
| `npx eslint src/slices/notifications/ports/push-sender.ts` (run from `apps/api`) | pass — exit 0 (targeted confirmation on the one changed file, after the final edit) |

The package-wide command was re-run after the last edit and its own exit code captured
directly (an earlier attempt piped turbo through `tail`, which masks the real status — that
result was discarded rather than reported).

## Acceptance criteria

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| The port comment is accurate, verified against `push-fcm.ts:224`/`:237` and `collapse-alias.ts:9-11` | **met** | Table above; every claim traced to a line, including the previously-omitted APNs field |
| `push-fcm.ts` validates `message.data`, returns `validation` DomainError, no request for invalid payload | **NOT MET** | Not implemented — unimplementable alongside the no-test-edits criterion; two variants proven to break 15 and 3 existing tests |
| A test proves the fail-closed path | **NOT MET** | Depends on the above |
| Every existing push test still passes unchanged | **met** (as-shipped) | 25/25; the only changed file is a comment. This criterion is precisely what blocks the one above |
| No change to `notify-event.ts`, the copy table, or the payload schema | **met** | Untouched |

## ASSESSED, NOT IMPLEMENTED — remove free-form `title`/`body` from `PushMessage`

**Verdict: feasible, genuinely correct, and it subsumes Finding B.** It is the better fix.

Today `PushMessage.title`/`body` are free-form strings that `notify-event.ts:114-118` fills
from `notificationCopyForCategory(input.category)` — the right values, by convention. The
FCM adapter forwards them verbatim into the Google payload (`push-fcm.ts:230`), so a future
call site typing a conversation title into `title` puts it in front of Google and in the
Android shade with nothing to stop it. Validating `data` (Finding B) does **not** close
this: `title`/`body` are separate fields the schema never sees. **Finding B is the weaker
half of this fix, and only this design closes the actual hole.**

The web path already proves the target design: the SW receives no text at all and derives
it at display time — `sw/handlers.ts:141` `const copy = notificationCopyForCategory(payload.category);`.
The native path is the only one still trusting caller-supplied strings.

The plan's standing amendment *"Alias-stamping is composite-only … no production code may
construct or call a raw transport sender directly — the factory/composite is the only
construction site"* cuts both ways here, and both cut toward this design:

- **It makes the refactor safe.** All production traffic provably funnels through the
  composite, so moving copy derivation into the adapters cannot strand a bypassing caller.
- **It does not close the hole.** The composite stamps the collapse alias but never
  inspects `title`/`body` (`push-composite.ts:28-40` only reads `data.conversationId`). A
  future call site routed correctly through the composite, as required, would still carry
  free-form text straight to `push-fcm.ts:230`. The mandated chokepoint enforces alias
  discipline, not content discipline — which is precisely why the fix has to be at the type
  level.

**Shape:** replace `title`/`body` on `PushMessage` with the `category` (already in `data`,
so arguably just make it a typed first-class field), and have the FCM adapter call
`notificationCopyForCategory` itself. Content becomes structurally unrepresentable, not
merely validated — and there is one copy source for all three surfaces (the
One-Implementation-Shared move).

**Blast radius — 11 source files, all inside the notifications slice** (verified by
`grep -rln PushMessage` over `apps` + `packages`, excluding `dist`):

| File | Change |
| --- | --- |
| `ports/push-sender.ts` | drop `title`/`body`, add typed `category` |
| `adapters/push-fcm.ts` | derive copy from category |
| `adapters/push-webpush.ts` | no behavior change (already sends only `data`); type-only |
| `adapters/push-composite.ts` | pass-through; likely type-only |
| `adapters/push-mock.ts` | type-only |
| `adapters/push-sender-factory.ts` | type-only |
| `domain/notify-event.ts` | stops calling `notificationCopyForCategory`; passes category |
| `push-fcm.test.ts`, `push-webpush.test.ts`, `push-composite.test.ts`, `push-mock.test.ts`, `push-sender-factory.test.ts`, `notify-event.test.ts` | fixtures updated |
| `push-fcm-live.integration.test.ts` | fixture updated |

Nothing outside the notifications slice imports `PushMessage`, and `packages/shared`'s copy
table and schema are untouched. `apps/web` is unaffected — the SW already derives copy.

**Risks:** (1) it must land as one commit — the port change breaks every adapter
simultaneously; (2) it touches Task 18's live-proof file, same coordination question as
Finding B question 2 above; (3) `notify-event.test.ts:109-110` asserts the outgoing
`title`/`body` equal `NOTIFICATION_COPY.runCompletion.*` — that assertion moves down to the
adapter, where it becomes a stronger test (it would then pin what actually reaches Google).
Low risk overall; no migration, no wire-format change (FCM still receives the same
`notification.title`/`body` strings — they are just derived one layer later).

**Recommendation:** rule on this *before* Finding B. If this is approved, Finding B should
be dropped rather than implemented — its test churn would be redone immediately, and the
guard it adds is subsumed.

## REPORTED, NOT ACTED ON — `NOTIFICATION_TAG_SECRET` naming defect

Confirmed. The secret keys the HMAC in `createCollapseAliasDeriver`
(`adapters/collapse-alias.ts:14-17`, via `push-sender-factory.ts`), which produces the
**collapse alias** — the FCM `collapse_key`, the APNs `apns-collapse-id`, and the Web Push
`Topic`. It has nothing to do with the notification **tag**; per `collapse-alias.ts:9-11`
and `push-fcm.ts:224`, the tag is the raw conversationId and is never HMAC'd. So the name
states the one thing the secret is provably not used for — the same class of wrong-comment
defect as Finding A, at the identifier level. `NOTIFICATION_COLLAPSE_SECRET` would be
accurate.

**Not renamed** (founder decision). Blast radius if ever taken: 32 non-`dist` files, and
critically it is a **live production secret** — `env.config.ts:451-457` (`secret(...)` in
Production) plus `.github/workflows/ci.yml:807`, `:962` (`wrangler secret put`), `:980`,
and `run-ops-script.yml:58`. A rename is a coordinated secret rotation across GitHub
Secrets and Cloudflare Workers, not a code edit — and a mismatch silently changes every
derived alias, which degrades collapse behavior without failing anything loudly. Worth
doing only bundled with another secrets change.

## Deviations

Finding B not implemented — see above. This is a stop under the brief's explicit
NEEDS_CONTEXT trigger, not a judgment call.

## Concerns and limitations

- The brief's safety argument for Finding B rested on a composite behavior that
  `push-composite.ts:60-62` does not have. Worth correcting wherever that reasoning is
  recorded, since it also underpins the "tightening a guard, not changing behavior" claim.
- Finding B as scoped omits `push-fcm-live.integration.test.ts` from its Files list, and
  that file cannot be avoided.
- The stronger design makes Finding B redundant; sequencing them the other way wastes work.

## Confidence

**high** — the blocker is empirical (two variants run, failure counts captured, baseline
restored), not inferred. Finding A's every claim is traced to a specific line.
