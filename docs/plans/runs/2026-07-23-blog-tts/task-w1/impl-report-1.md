# W1 — implementation report 1

## Objective

Add a build-output assertion to `scripts/verify-web-bundle.ts` that fails when a built
`tts.worker-*.js` chunk has had `new.target` rewritten to the bundler's synthesised
`import.meta` stand-in. Written first, verified RED against today's dists.

## Files changed

- `scripts/verify-web-bundle.ts` — new `checkWorkerMetaProperty` guard wired into
  `collectWebBundleViolations`; header comment updated from "Three classes" to "Four" with the
  new class described (a comment that enumerates the guards is wrong the moment a guard is
  added); `escapeIdentifier` extracted from `assignmentsTo` so the identifier-escaping rule has
  one implementation now that two regex builders need it.
- `scripts/verify-web-bundle.test.ts` — four new cases plus one baseline fixture line.

## Matching strategy (and why it survives minification)

The guard never looks for a name. It works in two steps, per worker chunk:

1. **Find the stand-in bindings by their declaration shape.** A bundler-synthesised
   `import.meta` stand-in is always declared as an object literal carrying the module URL:
   `var _vite_importMeta = { url: self.location.href }` (web) and
   `var df={url:self.location.href}` (marketing, minified). The regex matches the *identifier*
   via a lookahead onto that declaration, tolerating arbitrary whitespace, an optional `self.`
   prefix, and further properties in the literal (`[,}]` terminator — the marketing form is
   `var df={url:self.location.href},ff={…}`).
2. **Flag any `.prototype` read of a binding found in step 1**, in the same chunk.

So the identifier is *learned from the chunk being checked* rather than hardcoded. Minification
renaming `_vite_importMeta` to `df`, or to anything else next build, changes both the
declaration and the read together, and the guard follows. A guard keyed to the literal string
`_vite_importMeta` would have gone silently blind on the marketing build — the one users get.

Two deliberate choices worth an auditor's attention:

- **The trigger is the `.prototype` read, not `setPrototypeOf` specifically.** Reading
  `.prototype` off a `{url}` object is `undefined` by construction and is never intentional, so
  the read alone is the signal regardless of what consumes it. This is strictly broader than the
  brief's `setPrototypeOf(…, <ident>.prototype)` shape and cannot false-positive; it also catches
  the same corruption if a future transform routes it through a different consumer. The negative
  case is pinned by a test: a chunk that declares a stand-in and uses it *legitimately*
  (`Object(_vite_importMeta).url`, the real line 16439 of the web chunk) passes.
- **Literal `import.meta.prototype` is not matched.** The analyst's repro shows `new.target` is
  *preserved* under `worker: { format: 'es' }`, so that form does not arise; matching it would be
  a speculative branch.
- `match[0]` via lookahead rather than a capture group, following the idiom the file already
  documents for `ORT_VERSION_SITE` — no "group did not participate" branch to leave uncovered.

## Vacuity guard

Zero `tts.worker-*.js` chunks anywhere in the dist is itself a violation, same rule the
ORT-version check follows. Consequence for fixtures: the test file's `beforeEach` now writes one
benign baseline worker chunk, exactly as it already writes `ORT_VERSION_CHUNK` for the identical
reason (the file's own comment states that rationale). **No existing assertion was edited** —
only one line added to shared setup.

## Verified RED

### Unit RED (before implementation)

```
 FAIL  |scripts| verify-web-bundle.test.ts > … > reports a worker chunk whose new.target was rewritten to the import.meta stand-in
 FAIL  |scripts| verify-web-bundle.test.ts > … > reports a minified worker chunk whose import.meta stand-in was renamed
 FAIL  |scripts| verify-web-bundle.test.ts > … > reports a bundle that emitted no TTS worker chunk at all
AssertionError: expected [] to have a length of 1 but got +0
 Test Files  1 failed (1)
      Tests  3 failed | 23 passed (26)
```

Failing for the right reason (no violation produced yet), the clean-chunk case correctly passing
from the start, and all 23 pre-existing tests green under the new baseline fixture.

### RED against the real dists — the production-bug evidence

`verifyWebBundle` run unmodified against the existing, unrebuilt dists. Verbatim:

```
Web bundle verification failed (/workspace/popper-mobile/.superset/projects/HushBox/apps/web/dist):
  - built TTS worker reads `df.prototype` off the bundler's import.meta stand-in: _astro/tts.worker-Cnlg9VbG.js — the iife worker transform rewrote `new.target` as `import.meta`, so every worker throws "Object prototype may only be an Object or null: undefined" on load
  - built TTS worker reads `_vite_importMeta.prototype` off the bundler's import.meta stand-in: assets/tts.worker-CcCuWCez.js — the iife worker transform rewrote `new.target` as `import.meta`, so every worker throws "Object prototype may only be an Object or null: undefined" on load
-----
Web bundle verification failed (/workspace/popper-mobile/.superset/projects/HushBox/apps/marketing/dist):
  - built TTS worker reads `df.prototype` off the bundler's import.meta stand-in: _astro/tts.worker-Cnlg9VbG.js — the iife worker transform rewrote `new.target` as `import.meta`, so every worker throws "Object prototype may only be an Object or null: undefined" on load
```

Three facts this establishes, independent of the analyst's browser reproduction:

1. **Both dists are corrupt today.** `apps/web/dist` is the merged bundle and carries *both*
   worker chunks — the web build's unminified `_vite_importMeta` form and the merged marketing
   build's minified `df` form. `apps/marketing/dist` carries its own.
2. **The shape matcher caught the minified form.** `df` was found with no prior knowledge of the
   name — the property the brief called out as load-bearing.
3. **These are the only violations on the real dists.** Every pre-existing assertion
   (self-hosted `/ort/` hashes, stray copies, bundled-asset references, ORT version sites, Pages
   caps) passes against both real dists, so the guard is not riding on unrelated breakage.

Raw source confirmation of what is in those chunks:

```
apps/web/dist/assets/tts.worker-CcCuWCez.js:13311  var _vite_importMeta = { url: self.location.href };
apps/web/dist/assets/tts.worker-CcCuWCez.js:16439  const _import_meta_url = Object(_vite_importMeta).url;
apps/web/dist/assets/tts.worker-CcCuWCez.js:29812  return Object.setPrototypeOf(closure, _vite_importMeta.prototype);
apps/marketing/dist/_astro/tts.worker-Cnlg9VbG.js  var df={url:self.location.href},ff={…}  …  return Object.setPrototypeOf(e,df.prototype)
```

## Tests added

| Test | Behavior | Criterion |
| --- | --- | --- |
| accepts a worker chunk that reads the bundler import.meta stand-in normally | a chunk declaring a stand-in and reading `.url` off it is clean — no false positive on the legitimate use that exists in the real chunk | (1), (5) clean chunk passes |
| reports a worker chunk whose new.target was rewritten to the import.meta stand-in | the unminified `_vite_importMeta.prototype` form fails, message names file + identifier + `new.target` | (1), (4), (5) |
| reports a minified worker chunk whose import.meta stand-in was renamed | the `var df={url:self.location.href}` + `df.prototype` form fails — proves renaming does not defeat the guard | (1), (5) |
| reports a bundle that emitted no TTS worker chunk at all | zero worker chunks is itself a violation, message says "must not pass vacuously" | (2), (5) |

## Failure message

```
built TTS worker reads `<ident>.prototype` off the bundler's import.meta stand-in:
<relativePath> — the iife worker transform rewrote `new.target` as `import.meta`, so every
worker throws "Object prototype may only be an Object or null: undefined" on load
```

File, what was found, and the cause including the exact runtime error a reader would be
searching for. The durable mechanism (both are `MetaProperty` nodes; dev serves the worker as a
native ES module and never applies the transform, so only the built output can catch it) is in
the doc comment above the check, with no plan or task identifiers.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm exec vitest run verify-web-bundle` (from `scripts/`) | pass — 26/26, 1 file |
| coverage, `verify-web-bundle.ts` per-file | pass — statements 100%, branches 100%, functions 100%, lines 100% (101/101, 46/46, 27/27, 96/96) |
| `pnpm exec eslint verify-web-bundle.ts verify-web-bundle.test.ts` (from `scripts/`, after the final edit) | pass — 0 problems |
| `npx turbo typecheck lint --filter=@hushbox/scripts --force` | pass — 2/2 tasks, cache bypassed |
| `pnpm --filter @hushbox/scripts test` (full package) | 1848 passed, 4 failed — all four attributed below, none mine |

Lint initially flagged two errors on my new code (a prettier wrap and
`unicorn/no-useless-collection-argument` on `new Set(… ?? [])`); both fixed at the cause — the
`Set` is now built from a `matchAll` spread, matching the idiom the rest of the file uses. The
eslint run above is after the last edit, from the package directory.

### Failure attribution (all pre-existing, none touching this task's files)

- `generate-env.test.ts` — VAPID drift. Named as ambient in the brief.
- `refresh-catalog-run.test.ts`, `seed-run.test.ts` — stale `scripts/node_modules/.vite`
  artifact. Named as ambient in the brief.
- `verify-db-objects.integration.test.ts` — **not** named in the brief. Attributed by direct
  evidence: it fails inside `dumpDbObjects` on `db.execute(sql…)`, and run standalone it errors
  `DATABASE_URL environment variable is required for integration tests`. It is a local-Postgres
  integration test; `verify-web-bundle.ts` touches no database and this task changed nothing it
  imports. Local DB state, not this change. Raised to the orchestrator rather than fixed.

`build-web-bundle.test.ts`, the only consumer of `verifyWebBundle`, is green.

## Acceptance criteria

1. **Assertion fails on the `import.meta`-style rewrite, matched by shape not by name — met.**
   See §Matching strategy; both real identifier forms (`_vite_importMeta`, minified `df`) caught
   with no name hardcoded, plus a fixture test for each.
2. **Fails loudly rather than vacuously — met.** Zero `tts.worker-*.js` chunks is a violation,
   pinned by test, message explicitly says "must not pass vacuously".
3. **Verified RED against both existing dists — met.** Verbatim output above; `apps/web/dist`
   fails on two chunks, `apps/marketing/dist` on one.
4. **Failure message names file, finding, and cause — met.** See §Failure message.
5. **Fixture tests: clean passes, `_vite_importMeta` fails, minified rename fails, zero chunks
   fails — met.** Four tests, table above.
6. **95%+ per-file coverage; existing assertions keep passing unmodified — met.** 100% on all
   four axes for `verify-web-bundle.ts`. No existing assertion, expected value, or check was
   modified; the only edit outside new code is one line in shared `beforeEach` setup (see
   §Vacuity guard) and the header comment's guard count.

## Deviations

- **`escapeIdentifier` extracted from the existing `assignmentsTo`.** Two regex builders now need
  the same identifier-escaping rule; a second copy would be a duplication of a correctness rule.
  Behavior-preserving, pinned by the pre-existing ORT-version tests, which pass unmodified.
- **Header comment updated** from "Three classes of problem" to "Four", with the new class
  described. Required — the comment enumerates the guards and would otherwise be wrong.
- **Guard is broader than the brief's literal shape** (any `.prototype` read of a stand-in, not
  only inside `setPrototypeOf`). Justified in §Matching strategy; superset, cannot false-positive,
  and the no-false-positive case is pinned by a test.

## Concerns and limitations

- The guard cannot see a stand-in the minifier **inlines at the use site**
  (`Object.setPrototypeOf(e,{url:self.location.href}.prototype)`), since there would be no
  binding to learn. Not observed — the real chunks reference the binding three times and twice
  respectively — and adding that alternative now would be speculative. Recorded so a future
  reader knows the boundary.
- Scope is `tts.worker-*.js` by basename, per the brief. Another worker chunk introduced later
  under a different name would not be guarded; the vacuity check only proves *a* TTS worker
  chunk exists.
- W2 flips this guard to GREEN. If a rebuilt dist still fails, the message is the diagnosis;
  if it passes, that transition is the fix's proof.

## Confidence

**High** — the assertion fails on the real corrupted bytes in both dists and passes on the
legitimate stand-in use that sits in the same chunk, so both directions are demonstrated against
production output rather than fixtures alone; 100% per-file coverage; typecheck, lint, and the
consumer's tests green.
