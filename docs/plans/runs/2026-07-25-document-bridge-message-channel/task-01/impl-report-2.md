# T1 fix round 2 — stale intake comment, harness path traversal, double-React-failure pin

## Objective

Three items from the T1 audit, ownership unchanged: correct the intake comment in
`render/bootstrap.ts`, close the path traversal in the new `embed-harness.ts` static server, and
add a test pinning that two React failures from one commit round produce exactly one `error`.

## Files changed

| Path | Why |
| --- | --- |
| `apps/sandbox/src/render/bootstrap.ts` | Intake comment now states the true security model (port holder is the authority; the parse is input validation). No logic change. |
| `apps/sandbox/src/embed-harness.ts` | Decoded request pathname is normalized before it reaches `path.join`, closing the encoded-separator escape from `public/`. |
| `apps/sandbox/src/render/render.browser.test.ts` | Two tests added: the traversal refusal, and the double-React-failure pin (plus the route-scoped `react-dom/client` stand-in it needs). |
| `apps/sandbox/public/render.js` | Rebuilt after the bootstrap edit, as Global Constraint 8 requires. |

## FIX 1 — the intake comment

The removed text claimed the sender's origin is "deliberately not checked" and that
"authentication is by message *shape* alone". Both clauses were false: a `MessagePort` message event
carries `origin === ''`, so there is no sender origin to check or decline to check, and shape
parsing stopped being the authentication the moment the window listener went away. Replacement
states the durable facts — holding the other end of the channel is the embedder's authority, a
realm-sharing document can neither obtain the port nor find a window listener to post at, and
`parseParentToFrameMessage` validates the payload on a channel whose holder is already trusted.

The file header's transport paragraph (the `MessageChannel` docblock) already gave this account;
the file now gives one account, not two. Nothing else in the file was touched.

## FIX 2 — path traversal in the harness static server

**The finding is real, but the payload in the brief is not the one that works.** Measured with
Node's WHATWG URL parser:

| Request target | `url.pathname` | after `decodeURIComponent` | old `path.join(publicDir, '.' + p)` |
| --- | --- | --- | --- |
| `/%2e%2e/%2e%2e/x` | `/x` | `/x` | inside `public/` — **does not escape** |
| `/..%2f..%2fx` | `/..%2f..%2fx` | `/../../x` | `/x` — **escapes** |
| `/%2e%2e%2f%2e%2e%2fx` | `/%2e%2e%2f%2e%2e%2fx` | `/../../x` | `/x` — **escapes** |

The URL spec treats `%2e` as a dot segment and normalizes it away, so the brief's
`/%2e%2e/%2e%2e/x` is harmless. It is the encoded *separator* (`%2f`) that survives parsing and
only becomes a traversal on decode. The vulnerability stands; only the example changes.

Fix: `path.posix.normalize(decodeURIComponent(url.pathname))` — normalization applied after the
decode, at the point where the traversal actually exists. The absolute pathname makes a leading
`..` resolve to the root of the served tree rather than above it.

RED, against the pre-fix harness:

```
FAIL src/render/render.browser.test.ts > sandbox origin static server
  > refuses a percent-encoded path that would escape the served directory
AssertionError: expected 200 to be 404
```

The 200 was `apps/sandbox/package.json`, one level above `public/`, served through
`GET /..%2fpackage.json`. Green after the fix.

## ADD 3 — pinning the once-only React failure guard

New test: `reports one error when a React root reports two failures from one commit round`.
It drives a react document, lets both failures arrive, waits past the turn a second message would
land on, and asserts exactly one `error` for the request, carrying the first failure's text. One
message rather than zero is also what proves the case does not go silent.

**Why the shared module stub could not express it.** `src/esm-stub.ts`'s reconciler flushes effects
with `for (…) { try { effect(); } catch (error) { report(error); return; } }` — it returns at the
first throw, so its root reports exactly once no matter how many sibling effects would have failed.
That file is outside T1's ownership and is shared with the python specs, so it was not touched.

**Why the behaviour is real in production.** React 19.2 (`react-dom-client.development.js`)
routes every commit-phase error through `captureCommitPhaseError` → `captureCommitPhaseErrorOnRoot`,
which enqueues *its own* root error update per error; each of those updates calls
`logUncaughtError`, which calls the root's `onUncaughtError`. Two sibling effects throwing in one
commit round therefore call the frame's handler twice. (Read from the installed package source; not
executed.)

**How the test reaches it.** `page.route` on the embedder page fulfils the frame's
`react-dom/client` module request, for this one test only, with a stand-in whose root clears the
container and calls `onUncaughtError` twice in one microtask — React's shape, without React. No
production code was reshaped, and no shared fixture changed.

### RED observation — the test discriminates

The guard was temporarily moved *below* the `pendingRequestId === requestId` settle branch (the only
weakening that leaves the single-failure case behaving identically), the bundle rebuilt, and the test
run against it:

```
FAIL src/render/render.browser.test.ts > web renderer (real browser)
  > reports one error when a React root reports two failures from one commit round
AssertionError: expected [ { type: 'error', …(3) }, …(1) ] to have a length of 1 but got 2
```

Two `error` messages for one request — the exact regression the guard's position prevents. The
guard was then restored byte-exact from a pre-edit copy of the file (`reportReactFailure` diffed
back to identical), the bundle rebuilt, and the test passes. The guard's ordering and logic are
unchanged by this round.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm --filter @hushbox/sandbox test` | pass — 17 files, **159** tests (157 + 2 new), coverage 100% st/br/fn/ln |
| `pnpm exec tsx ../../scripts/with-env.ts vitest run src/render/` | pass — 5 files, 64 tests |
| `npx turbo typecheck lint --filter=@hushbox/sandbox --force` | pass — 2 successful, 2 total |
| `pnpm exec eslint src/embed-harness.ts src/render/bootstrap.ts src/render/render.browser.test.ts` (from `apps/sandbox`, after the final edit) | exit 0 |
| `pnpm lint:duplication` | pass — 1.02% duplicated lines, threshold 2% (unchanged; the `browser-harness.ts` clone pairs remain A2/T2's) |

Two failures were found and fixed inside this round before the gates went green: `page.route`
returns `Promise<Disposable>`, which broke the `beforeLoad: (page) => Promise<void>` contract
(fixed with a braced async body), and `(await frame.messages()).filter(…)` tripped
`unicorn/no-await-expression-member` (fixed by binding the awaited value first).

### Bundle drift, re-confirmed after the rebuild

```
✓ renderer bundle > keeps the committed public/render.js in sync with the source  350ms
✓ renderer bundle > writeRenderBundle rewrites the committed bundle from source   707ms
```

Both compare `toBe()` against a fresh `buildRenderBundle()`. The bundle is minified, so the comment
edit changed no bundle bytes (540,313 before and after; neither the old nor the new comment text
appears in `public/render.js`) — the rebuild was run regardless, as the constraint requires.

## Acceptance criteria (this round)

1. **Met.** Intake comment states the port-as-capability model and names
   `parseParentToFrameMessage` as payload validation; the two conflicting accounts are now one.
2. **Met.** `/..%2fpackage.json` returns 404; RED reproduced at 200 before the fix.
3. **Met.** Double-React-failure test passes, and fails with 2 errors against a deliberately
   weakened guard.

The eight original T1 criteria are untouched by this round and remain met; all 22 migrated tests
plus the 4 transport tests still pass.

## Deviations

None. No production logic changed — the only non-comment production edit in this round is the
harness normalization, and the harness is test infrastructure.

## Concerns and limitations

1. **The double-failure test's react-dom is a stand-in, not React.** It reproduces React's
   *reporting* shape (two `onUncaughtError` calls, tree torn down first) on the strength of the
   source reading above, not of a live React run. If React ever collapsed multiple commit-round
   errors into one report, this test would keep passing while pinning a case production no longer
   reaches — it would be stale, never wrong about `bootstrap.ts`.
2. **`decodeURIComponent` still throws on a malformed escape** (`/%zz`), which surfaces as an
   unhandled error in the harness's request handler rather than a 400. Pre-existing, test-only, and
   outside the fix I was asked to make; flagged rather than silently changed.
3. The `embed-harness.ts` ↔ `python/browser-harness.ts` duplication is unchanged and remains T2's
   to collapse per amendment A2.

## Confidence

**High.** Both fixes were driven by a reproduced RED — a 200 that should have been a 404, and a
second `error` message that should not exist — and both went green on the same command. The one
judgement call is the route-scoped react-dom stand-in, and it is disclosed above with the React
source that grounds it.
