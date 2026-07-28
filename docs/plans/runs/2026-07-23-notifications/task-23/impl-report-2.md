# Task 23 — impl report 2 (fix pass: three validated Minor documentation findings)

## Objective

Correct three documentation-accuracy defects found by the audit, without touching the
predicate or the rule's behavior: (1) the factually wrong `vi.spyOn` justification in
`rule.ts` and `README.md`; (2) the README's understated evasion surface; (3) the
undocumented `SOURCE_GLOBS` coverage limit. Plus the audit's refinement: state the
real-db vs fake-db distinction that separates the shape the rule catches from the harm
it exists to prevent.

## Files changed

- `packages/config/arch/rules/no-evidence-from-mocked-seam.rule.ts` — comment text only
  (header paragraph + the `MOCK_FACTORIES` doc comment). No executable line changed.
- `packages/config/arch/README.md` — the `no-evidence-from-mocked-seam` entry: corrected
  discriminator sentence, new "Verified escapes" list, new "Coverage limit" paragraph,
  and the real-db/fake-db refinement inside the invariant section.

No tests added or changed: this pass adds no behavior. The existing 14 rule tests are the
behavior pin and all still pass.

## Predicate and `MOCK_FACTORIES` — byte-unchanged

`MOCK_FACTORIES` still reads, verbatim:

```ts
const MOCK_FACTORIES = new Set(['fn', 'mock', 'doMock', 'spyOn', 'stubGlobal']);
```

Both `Edit` operations replaced strings that lie entirely inside comment blocks (the second
edit's `old_string`/`new_string` both contain the `const` line above, character-identical).
Comment-stripped, the rule file is 165 code lines; sha256 of the stripped source is
`da5ac77a3ea15eb5025449c13ee3d4ae08fcc4e3ba2ba78ac25f6a9b81bfe52c`. `spyOn` stays in the
set, as the finding directs.

## Finding 1 — the `vi.spyOn` justification (corrected in both places)

**Verified first, then written.** `@vitest/spy`'s dist resolves a call as
`onceMockImplementations.shift() || config.mockImplementation || … || original || noop`
(dist/index.js:303), and `spyOn` passes the spied function in as `originalImplementation`
(dist/index.js:216, 250). So a bare `vi.spyOn(globalThis, 'fetch')` calls through to the
real `fetch` — the audit's claim is correct.

Consequence re-verified against the real rule (scratch ts-morph harness, not committed):

```
[PASS] expected FLAG, got FLAG — F1: bare delegating spyOn + isCI:true (accepted over-fire)
```

fixture: `const fetchImpl = vi.spyOn(globalThis, 'fetch');` +
`createFcmPushSender({ projectId: 'p', fetchImpl, db, isCI: true })`.

### The corrected sentence — `rule.ts`

The header's discriminator paragraph now reads (the corrected part quoted):

> The discriminator is vitest's mocking surface: a `vi.fn`/`vi.mock`/`vi.doMock` value, or
> a `vi.stubGlobal` replacement of the global `fetch`, has no socket behind it, and a
> wrapper that delegates never needs one. `vi.spyOn` is in that set for a different reason
> — it is the entry point to `mockImplementation`, the shape a fake takes when it replaces
> an existing function. A bare `vi.spyOn(globalThis, 'fetch')` with no `mockImplementation`
> does call through to the real `fetch`, so a capture-and-delegate spy passed to an adapter
> alongside `isCI: true` is flagged even though its transport is real. That is a known,
> accepted over-fire, not a reason to drop `spyOn`: dropping it would let every
> `spyOn(...).mockImplementation(...)` fake through.

The `MOCK_FACTORIES` doc comment (the `rule.ts:51-52` the finding names) now reads:

> Vitest's mock-installing surface. `fn`/`mock`/`doMock`/`stubGlobal` produce a value with
> no socket behind it; `spyOn` is included because it is the entry point to
> `mockImplementation` — a bare delegating spy is an accepted over-fire (see the header),
> never a reason to remove it from this set.

**Scope note (deviation, flagged):** the finding cited `rule.ts:51-52`, but the same wrong
claim ("a value produced by `vi.fn`/`vi.mock`/`vi.spyOn` … is a value with no socket behind
it") also sat in the file header. Leaving one correct and one wrong copy would be exactly
the failure mode the finding is about, so both were corrected. Still comment-only.

### The corrected sentence — `README.md`

> The discriminator is vitest's mocking surface: a `vi.fn`, `vi.mock`, `vi.doMock` or
> `vi.stubGlobal` value has no socket behind it, and a wrapper that delegates never needs
> one. `vi.spyOn` is in the set for a different reason — it is the entry point to
> `mockImplementation`, the shape a fake takes when it replaces an existing function. A
> bare `vi.spyOn(globalThis, 'fetch')` with no `mockImplementation` **does** call through
> to the real `fetch`, so a capture-and-delegate spy passed alongside `isCI: true` is
> flagged even though its transport is real: a known, accepted over-fire, and not a reason
> to drop `spyOn` (dropping it would let every `spyOn(...).mockImplementation(...)` fake
> through).

## Findings 2 and 3 — the README diff

Every escape in the list was executed against the real rule before being written down
(same scratch harness):

```
[PASS] expected CLEAN, got CLEAN — F2a: hand-written fake, no vi.*
[PASS] expected CLEAN, got CLEAN — F2b: isCI passed as shorthand variable, not a true literal
[PASS] expected CLEAN, got CLEAN — F2c: globalThis.fetch = vi.fn() assignment + recordServiceEvidence
[PASS] expected CLEAN, got CLEAN — F2d: msw setupServer + recordServiceEvidence
[PASS] expected CLEAN, got CLEAN — F2d: module-level vi.mock + recordServiceEvidence
```

(F2c passes because `rootIdentifier` of `globalThis.fetch = vi.fn()` binds the name
`globalThis`, not `fetch`, and only `vi.stubGlobal('fetch', …)` is matched as a global
replacement.)

Appended after "What it does not prove":

> **Verified escapes — do not read the guard as total.** Each of these passes the rule
> today:
>
> - An in-file hand-written fake that touches no `vi.*` at all, such as an
>   `async () => Response.json({ name: 'x' })` bound to `fetchImpl`. This is the repo's own
>   prevailing style (`payment-helcim-fixtures.ts`'s `createFixtureFetch`,
>   `gateway-metadata.test.ts`), so it is the likeliest escape, not a contrived one.
> - `isCI` passed as a shorthand or a variable rather than a `true` literal — a one-token
>   mutation of the actual `push-fcm` violator.
> - `globalThis.fetch = vi.fn()` / `global.fetch = vi.fn()` assignment (only
>   `vi.stubGlobal('fetch', …)` is recognized).
> - msw's `setupServer` and module-level `vi.mock('./transport.js')`, which fake the
>   transport without ever naming a `fetch` slot.
>
> **Coverage limit:** `run.ts`'s `SOURCE_GLOBS` do not include `apps/api/src/platform/**`,
> `apps/api/src/jobs/**` or `scripts/**`, so real `recordServiceEvidence` callers living
> there (`linear-real.integration.test.ts` is one) are never seen by this rule. Widening
> the globs changes the input to every rule in the directory, so it is a deliberate
> decision, not a tidy-up.

Finding 3 is documented only; `SOURCE_GLOBS` is untouched (`git status packages/config`
shows no change to `run.ts`). Verified independently: `SOURCE_GLOBS` (run.ts:24-35) lists
`slices`, `lib`, `middleware`, `app.ts`, web, db schema, shared, crypto and package
barrels — none of the three named trees; and `grep -rl recordServiceEvidence` over those
trees returns `apps/api/src/platform/roadmap/linear-real.integration.test.ts` (call at
line 134) and `scripts/verify-evidence.ts`.

Appended inside the invariant section (the audit's refinement):

> What made those two files harmful, precisely, is that the faked transport sat next to a
> **real database connection** (`createDb`): a real `service_evidence` row landed from a
> call that never left the process. A test that fakes the transport but hands the adapter
> a spy or fake db — `payment-helcim.test.ts` does exactly this — cannot write a real row
> at all, so it is harmless. The rule keys on the shape (fake transport + open evidence
> gate) because that is what is statically visible; the harm it exists to prevent is the
> narrower fake-transport-plus-real-db combination.

Grounded: `payment-helcim.test.ts:341` returns `{ db: { insert } as unknown as Database }`
and passes it to `evidenceProvider(fixture, db, true)`.

## Self-gate

| command                                             | result                                                       |
| --------------------------------------------------- | ------------------------------------------------------------ |
| `pnpm arch:check`                                   | **pass** — `arch:check: OK — 12 rule(s) over 2031 file(s)`   |
| `pnpm test:config`                                  | **pass** — 30 test files, all green; `no-evidence-from-mocked-seam.rule.test.ts` 14/14; coverage `All files 97.99 / 95.89 / 98.86 / 99.18` |
| `turbo lint typecheck --filter=@hushbox/config --force` | **pass** — 2 tasks successful, 0 cached                  |
| `npx eslint <both owned rule files>` (from `packages/config`, after the final edit) | **pass** — exit 0                       |
| `npx prettier --check packages/config/arch/README.md` | **pass** — clean                                            |

Identical rule count (12) and identical test/coverage numbers to impl-report-1 — the
evidence that no behavior moved.

## Acceptance criteria (the three findings)

- **Finding 1 — corrected in `rule.ts` and `README.md`, `spyOn` kept, over-fire named** —
  met; both corrected sentences quoted above, the over-fire verified as a FLAG against the
  real rule, `MOCK_FACTORIES` byte-unchanged.
- **Finding 2 — the four concrete escapes listed in the README** — met; all four executed
  against the real rule and confirmed CLEAN before being documented.
- **Finding 3 — coverage limit recorded, globs NOT widened** — met; `run.ts` untouched.
- **Refinement — real-db vs fake-db distinction stated** — met.
- **No predicate/behavior change** — met; comment-only in `rule.ts`, prose-only in the
  README, all four checks unchanged.

## Deviations

1. The `vi.spyOn` correction was applied to the `rule.ts` header paragraph as well as the
   cited `rule.ts:51-52`, because the header carried the same wrong claim (detailed above).
2. `prettier --write` on the README also normalized one **pre-existing** line outside my
   edits — line 99, in the `demo-isolation` entry (a two-space dedent of a wrapped inline
   code span). Verified pre-existing: `git show HEAD:packages/config/arch/README.md` is
   itself prettier-red on that exact line. Kept rather than reverted, since pre-commit
   reformats and re-stages the file regardless; raising it so it is not read as a stray
   edit.

## Concerns and limitations

- The accepted `spyOn` over-fire is now documented but not tested. I deliberately added no
  test for it: the brief scoped this pass to documentation, and a test asserting the
  over-fire would encode current behavior as intended behavior, which is a decision above
  my level. If the auditor wants it pinned, it is a three-line addition to the existing
  `.rule.test.ts`.
- The escape list is a snapshot of what is true today. It is honest documentation, not a
  backlog — closing any of these (particularly the hand-written-fake escape, which the
  repo's prevailing fixture style makes the most reachable) would require a broader
  predicate than the ground-truth files justified.
- All CAVEATS from impl-report-1 stand unchanged: this catches a shape, not a fact.

## Confidence

**High.** Every factual claim written into the docs was executed or read out of source
first — `spyOn`'s call-through from `@vitest/spy`'s dist, the over-fire and all four
escapes through the real rule, the glob gap from `run.ts` plus a grep of the three trees,
and the fake-db shape from `payment-helcim.test.ts`. No executable line changed, and all
four checks report the same numbers as before the pass.
