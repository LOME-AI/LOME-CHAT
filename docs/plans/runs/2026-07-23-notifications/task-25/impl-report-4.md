# Task 25 — impl report 4 (fix round 3, comment-only)

## Objective

Two Minor findings from the round-3 re-audit, both on the same comment block in
`apps/api/src/slices/notifications/index.ts`, both comment-only:

1. The block claims un-exporting the transports makes the bypass "unreachable across the
   boundary rather than merely discouraged". That is a false claim about a security
   property. Replace it with wording that is true, verified against
   `boundaries.config.mjs` directly rather than against the brief or the old comment.
2. The block is a `/** … */` JSDoc sitting immediately above
   `export { createPushSenderFromEnv, listCapturedPushes }`, so TS tooling attaches it as
   the documentation of those two unrelated exports. Make it bind to nothing.

**No code changed this round.** One file touched, comment text only.

## Files changed

| File | Why |
| --- | --- |
| `apps/api/src/slices/notifications/index.ts` | Corrected the false structural-impossibility claim; converted the block from JSDoc to `//` so it stops binding to the two exports below it |

`git status` snapshot taken before the edit; the tree carries heavy concurrent churn from
other workstreams (~40+ modified files across `apps/api`, `apps/web`, `packages/`). Nothing
outside the single file above was touched by me.

## Finding 1 — the false claim

### The fact the correction rests on

The brief cited `packages/config/eslint-extensions/boundaries.config.mjs:112`. **That line
number is off** — line 112 is the `];` closing the `elements` array. The `files` glob that
scopes the boundaries rule is **line 118**, quoted verbatim:

```js
    files: ['**/src/slices/**/*.ts', `${LIB_GLOB}.ts`, '**/src/middleware/**/*.ts'],
```

with `LIB_GLOB` (`:51-52`):

```js
const LIB_GLOB =
  '**/src/lib/{result,errors,resilience,idempotency,jobs,telemetry,context,redis}/**/*';
```

**My reading: it does NOT cover `apps/api/src/adapters/**` or `apps/api/src/app.ts`.** The
three globs are `src/slices/**`, eight enumerated `src/lib/*` subdirectories, and
`src/middleware/**`. `src/adapters/` is none of them, and `src/app.ts` sits at `src/` root,
matched by none of them. The whole `boundaries/dependencies` rule (`:127-212`) lives inside
that one flat-config object, so a file the `files` glob does not select is never linted by
it at all — the element classifications at `:59-112` are irrelevant for such a file, because
the rule never runs on it.

The auditor's finding is therefore correct, and the old comment was wrong.

### Empirical confirmation — this is not a reading, it is already happening

`apps/api/src/adapters/push-notify.ts:8` today contains:

```ts
import { createPushMembershipReader } from '../slices/conversations/adapters/push-membership-reader.js';
```

That is the composition root deep-importing a **slice adapter module**, past the
`conversations` barrel — exactly the shape the boundaries rule forbids from any file it
covers — and `turbo lint --filter=@hushbox/api --force` is green (§Self-gate). Same pattern
at `push-notify.ts:16` and `adapters/conversation-room.ts:2`. So a
`import { createFcmPushSender } from '../slices/notifications/adapters/push-fcm.js'` from
`push-notify.ts` or `app.ts` is lint-legal today. I also checked the arch rules: the three
that mention slices (`admin-op-purity`, `do-classes-live-in-realtime`,
`single-writer-per-table`) address unrelated properties; none covers this.

I did **not** find the glob covering the composition root, so the brief's premise stands and
the old wording was the wrong one.

### Old text (verbatim, in full)

```ts
/**
 * The raw FCM and Web Push transports are deliberately NOT exported. Only the
 * composite sender derives and stamps the per-conversation collapse alias and
 * validates the wire payload, so a direct binding of either transport would
 * bypass both. Keeping them inside the slice makes that bypass unreachable
 * across the boundary rather than merely discouraged.
 */
```

### New text (verbatim, in full)

```ts
// The raw FCM and Web Push transports are deliberately absent from this barrel:
// only the composite sender derives and stamps the per-conversation collapse
// alias and validates the wire payload, and a directly-bound transport skips
// both. `createPushSenderFromEnv` is the only construction site outside this
// slice. That narrows the public surface rather than closing the bypass — the
// composition root sits outside the boundaries lint's slice/lib/middleware
// globs, so a deep import of an adapter module there is not rejected.
```

### Every claim in the new text, and what backs it

| Claim | Verification |
| --- | --- |
| The transports are absent from this barrel, deliberately | The removal is round 3's item 2; `index.ts` carries no `push-fcm.js` / `push-webpush.js` export |
| Only the composite derives and stamps the collapse alias | `push-composite.ts:36+` — `deriveCollapseKey(message.payload.conversationId)` is called there and nowhere else in the send path; `CompositePushSenderDeps.deriveCollapseKey` is documented as "Derives per-conversation collapse alias (a truncated HMAC)" |
| …and validates the wire payload | `push-composite.ts:38-42` — `pushEventPayloadSchema.safeParse(message.payload)`, `errAsync(validationError(...))` before either transport |
| A directly-bound transport skips both | Follows from the two above: both live in the composite, which a direct binding does not go through |
| `createPushSenderFromEnv` is the only construction site outside this slice | Repo-wide grep: the sole non-test caller outside `slices/notifications/` is `apps/api/src/adapters/push-notify.ts:46`. `createCompositePushSender` is also on the barrel but has no consumer outside the slice's own `push-sender-factory.ts` and colocated tests |
| It narrows the surface rather than closing the bypass; the composition root is outside the lint globs | §"The fact the correction rests on" + the live `push-notify.ts:8` deep import above |

No claim of structural impossibility remains. The sentence that made one is deleted, and the
replacement states the opposite explicitly so the next reader cannot re-acquire the belief
that got this comment written — which is the durable fact worth the two extra lines.

## Finding 2 — the block bound to the wrong symbols

### Confirmed before the fix

Probe over the real `typescript` in `node_modules`, walking the barrel's export specifiers
and asking `ts.getJSDocCommentsAndTags` what attaches to each:

```
BOUND -> export createPushSenderFromEnv (line 56): ["/**"]
BOUND -> export listCapturedPushes (line 56): ["/**"]
--- leading trivia of the push-sender-factory export statement ---
kind=BLOCK(/*) :: "/**\n * The raw FCM and Web Push transports are deliberately NOT exported. Only the\n * comp"
```

The finding is real: TS attached the transports paragraph as the documentation of **both**
`createPushSenderFromEnv` and `listCapturedPushes`.

### Confirmed after the fix

Same probe, same file:

```
--- leading trivia of the push-sender-factory export statement ---
kind=LINE(//) :: "// The raw FCM and Web Push transports are deliberately absent from this barrel:"
kind=LINE(//) :: "// only the composite sender derives and stamps the per-conversation collapse"
kind=LINE(//) :: "// alias and validates the wire payload, and a directly-bound transport skips"
kind=LINE(//) :: "// both. `createPushSenderFromEnv` is the only construction site outside this"
kind=LINE(//) :: "// slice. That narrows the public surface rather than closing the bypass — the"
kind=LINE(//) :: "// composition root sits outside the boundaries lint's slice/lib/middleware"
kind=LINE(//) :: "// globs, so a deep import of an adapter module there is not rejected."
```

**Zero `BOUND ->` lines** — the block now binds to nothing. The comment is still in the
statement's leading trivia (so it reads in-place, where it belongs), but as
`SingleLineCommentTrivia`, which is not JSDoc and is not collected.

### What a hover actually shows now

The trivia probe proves nothing is *attached*; the brief asked what a **hover** would show,
so I ran a real `ts.createLanguageService` and called `getQuickInfoAtPosition` on each of the
two export identifiers:

```
hover(createPushSenderFromEnv) documentation = "envUtils-gated composite sender. Every mode returns the composite (FCM +
Web Push behind one seam); local dev and CI back both partitions with the
in-process mock (no real push leaves either mode), production wires the real
FCM and in-house Web Push transports. The collapse-alias HMAC key is required
in every mode — it is stamped on the mock too — and missing FCM/VAPID
credentials in production fail fast (there is no degraded mode)."

hover(listCapturedPushes) documentation = "Newest-last list of every mock-delivered push (dev push viewer)."
```

Each export now hovers with its **own** JSDoc from `push-sender-factory.ts`, and neither
shows the transports paragraph. That is the correct end state.

## Self-gate

| Command | Result |
| --- | --- |
| `npx turbo lint typecheck --filter=@hushbox/api --force` (after the last edit) | **pass** — `Tasks: 2 successful, 2 total` |
| `npx turbo lint typecheck --filter=@hushbox/api` (re-run, to capture the exit code) | **pass** — `TURBO_EXIT=0`, `Tasks: 2 successful, 2 total` |

Both runs report `0 cached` — the second did not replay a cache entry, it re-executed
(concurrent workstreams are changing this package's inputs between runs), so the exit code is
that of a genuine second execution rather than a replayed one.

No test run this round: the change is comment text with no runtime or type consequence, so
there is no behavior to drive red-green. The typecheck above is the check that the file still
parses and resolves; lint is the check that the formatting (Prettier-as-ESLint-rule) is right.

### Known-red, declared not mine, and not re-run

`template-html.test.ts` snapshots (founder-owned), the `coverage/.tmp` ENOENT Vitest defect,
and knip's two pre-existing items. Comment-only edits cannot touch any of them, and I ran no
suite this round, so none reproduced here.

## Acceptance criteria

| Item | Verdict | Evidence |
| --- | --- | --- |
| 1 — replace the false structural-impossibility claim with true wording | **met** | Old and new text quoted in full; every claim in the new text tabulated against its source; the `:118` glob quoted with my own reading, plus live proof from `push-notify.ts:8` that the composition root already deep-imports a slice adapter lint-green |
| 1a — verify the glob myself rather than trusting the brief | **met** | Read `boundaries.config.mjs` directly. The brief's line number (`:112`) is wrong — the glob is `:118` — but its substance is right; I did not find the glob covering the composition root, so no stop was warranted |
| 2 — the doc block must not bind to unrelated exports | **met** | `ts.getJSDocCommentsAndTags` probe: two `BOUND ->` lines before, zero after; language-service `getQuickInfoAtPosition` on both exports shows only their own JSDoc |
| Comment-only — no code changed | **met** | Single file, single hunk; the diff is the comment block's eight lines. The `export` statement below it is byte-identical |
| Gate — `turbo lint typecheck --filter=@hushbox/api --force` green after the last edit | **met** | §Self-gate, exit 0 |

## Deviations

- **The brief's line citation was off by six** (`boundaries.config.mjs:112` → the `files`
  glob is at `:118`). Corrected silently in the sense that I verified the right line; recorded
  here because the brief asked me to check the fact and stop if it came out the other way. It
  did not — the conclusion is unchanged, only its address.
- **The new comment names the lint's scope** ("slice/lib/middleware globs") rather than
  stopping at "not enforced". This is one clause more than the brief's minimum. Reason: the
  false claim was acquired precisely because nobody could see where enforcement stopped, and
  a reader who knows *which* trees are covered can check the claim in one grep. It does not
  name a file path (which CODE-RULES bans as movable); it names directory roles.

## Concerns and limitations

- **The comment is now accurate but the gap it describes is still open.** Nothing prevents
  `apps/api/src/adapters/**` or `app.ts` from deep-importing `push-fcm.js` / `push-webpush.js`
  and shipping unstamped, unvalidated pushes. The only closures are (a) extending the
  boundaries `files` glob to cover the composition root — which would immediately fail on the
  three existing legitimate deep imports (`push-notify.ts:8,16`, `conversation-room.ts:2`) and
  so is not a drop-in — or (b) a targeted arch rule. Both are out of scope for a comment-only
  round; raising rather than adding.
- **The three existing deep imports are the real finding under the finding.** They are
  pre-existing and not mine, but they are evidence that "the composition root reaches past
  slice barrels" is an established pattern here, not a hypothetical. Any future decision to
  extend the boundaries glob has to rule on them first.
- **Comment accuracy is not gated by anything.** If the boundaries glob is later widened, my
  final clause goes stale with no test to catch it — the same failure mode as the comment I
  just replaced, one level down. I know of no cheap guard for this and am not proposing one.

## Confidence

**high.** Both findings were confirmed empirically before the change and re-confirmed after,
with tools rather than reading: the glob was read at source and cross-checked against a live
lint-green deep import that the rule would reject if it applied, and the JSDoc binding was
measured with the TypeScript compiler API and then with a real language-service hover. The
change carries no runtime or type surface, and the package's lint and typecheck are green at
exit 0 after the last edit.
