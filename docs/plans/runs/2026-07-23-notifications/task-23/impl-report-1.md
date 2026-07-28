# Task 23 — impl report 1

## Objective

Make the founder's evidence rule structural repo-wide: a new ts-morph arch rule that flags
the historical "evidence row written behind a mocked HTTP seam" defect, without flagging the
one file in the repo that hands an adapter a `fetchImpl` correctly.

## The predicate (one sentence)

> A backend file is flagged when it **both** installs a faked HTTP transport — a value produced
> by vitest's mocking surface (`vi.fn` / `vi.mock` / `vi.doMock` / `vi.spyOn`, reached directly
> or through a variable, a reassignment, or a local factory function it is bound to), or a
> `vi.stubGlobal` replacement of the global `fetch` — **and** enables a service-evidence write,
> which is either an `isCI: true` literal in the *same options object* that receives the fake,
> or any `recordServiceEvidence(…)` call anywhere in the file.

**Why it separates a faked transport from a wrapped real one.** A real-delegating wrapper is an
ordinary first-party function that `await`s the real global `fetch` and hands back its response
(`capturingFetch` in `push-fcm-live.integration.test.ts`), or a first-party factory closing over
`globalThis.fetch` (`createCassetteFetch` in `gateway-metadata.integration.test.ts`). Neither
needs — or touches — `vi.*` anywhere in the file: there is a real socket underneath, so there is
nothing to mint a canned response with. `vi.*` is precisely the marker of "no socket behind this
value". Keying on the mere presence of a `fetchImpl` property, as the naive rule would, flags the
honest file; keying on the vitest mocking surface does not.

## Ground truth — the rule run against the three real files individually

Verification harness (scratchpad, not committed) built a ts-morph project per file: the two
violators recovered verbatim via `git show HEAD:<path>`, the honest file read verbatim off disk.

```
[PASS] expected FLAG, got FLAG — pre-fix push-fcm.integration.test.ts (git show HEAD:)
    line 95: Service evidence must never be written behind a faked HTTP transport (mock installed at line 93). An evidence row is wha…

[PASS] expected FLAG, got FLAG — pre-fix email-resend.integration.test.ts (git show HEAD:)
    line 130: Service evidence must never be written behind a faked HTTP transport (mock installed at line 51). An evidence row is wha…

[PASS] expected CLEAN, got CLEAN — current push-fcm-live.integration.test.ts (real file on disk)
```

Reported locations confirmed against the sources:

- `push-fcm.integration.test.ts` HEAD line 93 = `      fetchImpl,` (shorthand, bound at line 84
  by `fetchImpl = vi.fn();`), line 95 = `      isCI: true,` — same `createFcmPushSender({…})`
  options object.
- `email-resend.integration.test.ts` HEAD line 51 = the first faked `fetchImpl` shorthand
  (`const sender = createResendEmailSender({ apiKey: 're_test_key', db, isCI: false, fetchImpl });`,
  where `fetchImpl` came from the `okFetch()` factory that returns `vi.fn(…)`), line 130 = the
  `isCI: true` in the `createResendEmailSender({…})` that also passes `fetchImpl: okFetch(messageId)`.

## Files changed

- `packages/config/arch/rules/no-evidence-from-mocked-seam.rule.ts` — new (auto-discovered by
  the harness; no registration file exists, so nothing outside `packages/config/` was touched).
- `packages/config/arch/rules/no-evidence-from-mocked-seam.rule.test.ts` — new; colocated
  `.rule.test.ts` in the existing in-memory-`Project` style of the sibling rule tests.
- `packages/config/arch/README.md` — appended the rule to the "Current rules" list, documenting
  the rule mechanics **and** the invariant behind it.

## Tests added (14, all in `no-evidence-from-mocked-seam.rule.test.ts`)

Violating shapes:

1. `flags a mocked fetch handed to an adapter alongside a hardcoded isCI: true` — the
   `push-fcm.integration.test.ts` shape (`let`-then-assign mock, shorthand property).
2. `flags a mocked fetch built by a local helper alongside a hardcoded isCI: true` — the
   `email-resend.integration.test.ts` shape (`okFetch()` factory returning `vi.fn`).
3. `flags a mocked fetch cast to the fetch type alongside a hardcoded isCI: true` — the
   `as typeof fetch` / `as Mock<typeof fetch>` indirection.
4. `flags a mocked fetch written inline into the adapter options` — `fetchImpl: vi.fn()`.
5. `flags a file that records evidence directly while passing a mocked fetch` — the
   `recordServiceEvidence` arm.
6. `flags a file that records evidence while stubbing the global fetch` — the `vi.stubGlobal`
   arm.
7. `reports one violation per file even when several shapes are present`.

Compliant shapes (the anti-false-positive half):

8. `passes a fetch wrapper that delegates to the real global fetch and records evidence` — the
   `capturingFetch` shape, i.e. the CRUX file.
9. `passes an inline wrapper that delegates to the real global fetch`.
10. `passes a first-party cassette transport holding the real global fetch` — the
    `gateway-metadata.integration.test.ts` shape.
11. `passes a mocked fetch when the file enables no evidence write`.
12. `passes a hardcoded isCI: true when the transport is not faked` — the
    `resolve-model-provider.test.ts` shape (`vi.fn` present, but for a db spy, not fetch).
13. `passes a production adapter that records evidence with no test doubles` — the
    `payment-helcim.ts` shape.
14. `ignores web files, which never write service evidence`.

TDD: the test file was written first and run before the rule existed — it failed with
`Cannot find module './no-evidence-from-mocked-seam.rule.js'`, then went green on implementation.
The later lint-driven refactor (splitting `mockedBindingNames`, optional chain) and the coverage
refactor kept all 14 green.

## Self-gate

| command | result |
| --- | --- |
| `pnpm arch:check` | **pass** — `arch:check: OK — 12 rule(s) over 2031 file(s)` (11 rules before), 6.5 s wall |
| `pnpm test:config` | **pass** — 30 test files, 369 tests, coverage gate green (`All files 97.99 / 95.89 / 98.86 / 99.18`) |
| `turbo lint typecheck --filter=@hushbox/config --force` | **pass** — both tasks successful, no cache |
| rule-file coverage (`--coverage.include` scoped) | 100% statements / 100% branches / 100% functions / 100% lines |

Lint was red on the first run and fixed at the cause, not silenced: `complexity 11>10` +
`sonarjs/cognitive-complexity 15>10` on `mockedBindingNames` (split into three named collectors,
one per binding shape) and one `@typescript-eslint/prefer-optional-chain`. Re-run from the
package directory after the final edit: clean.

`git status packages/config` shows exactly three entries — the two new rule files and the
README modification. No file outside `packages/config/` was touched.

## Acceptance criteria

- **Flags both historical violators, recovered from git and used as fixtures** — met. Both
  `FLAG` above; the shapes are reproduced as committed in-memory fixtures (tests 1 and 2).
- **Must NOT flag `push-fcm-live.integration.test.ts`, verified against the real file** — met.
  The verification read the real file off disk byte-for-byte (`readFileSync`), not a paraphrase;
  test 8 additionally pins the shape.
- **Colocated `.rule.test.ts` matching existing tests' style, covering violating and compliant
  shapes** — met. Same `projectWith(files)` in-memory-`Project` helper as
  `demo-isolation.rule.test.ts` / `no-drizzle-operators-in-barrels.rule.test.ts`; 7 violating +
  7 compliant cases.
- **`pnpm arch:check` green repo-wide with the rule active** — met, output above. Zero current
  files trip the rule; I checked the whole candidate population by hand first (every file
  containing `isCI: true`, and every file with a fetch-anchored `vi.*`) and confirmed the
  intersection is empty.
- **README documents the rule AND the invariant** — met; see the diff summary below.
- **No plan/task-ID labels in shipped code** — met; neither file nor the README addition names a
  task number, run directory, or plan section.

## README addition — what it documents beyond mechanics

The entry has four labelled parts. Mechanics is only the first paragraph; the rest is the
invariant the crux depends on:

- **"The invariant, and why fcm/webpush/resend differ from helcim/r2"** — states the rule as
  *an adapter may record evidence only where its real implementation actually executes in CI*;
  names the true cases (helcim = real sandbox charge, hookdeck, r2 = real S3 PUT, openrouter =
  real cassette-backed fetch) and the false ones; explains that `push-sender-factory.ts` and
  `email-sender-factory.ts` return mocks for `isLocalDev || isCI` **because** FCM has no sandbox,
  a real adapter would fire real sends at the junk tokens E2E seeds, and `/dev/push` depends on
  the mock; and says in bold that **those factories are correct and must not be "fixed"**, which
  is the specific misreading that would reintroduce the defect. It records what actually went
  wrong (evidence code inside an adapter the factory mocks away, making "real call" and `isCI`
  mutually exclusive) and where evidence for those three belongs instead.
- **"Separating a fake from a real-delegating wrapper"** — why the naive `fetchImpl` predicate is
  wrong, and what the discriminator is.
- **"What it does not prove"** — the caveat, in the README as well as the rule's own header.

## Deviations

None from the acceptance criteria. Two implementation choices worth naming:

- The rule is gated off `apps/web/src/**` (web code writes no service evidence), matching the
  README's stated convention that every rule but `demo-isolation` stays inert over web files.
- Registration needed no file outside `packages/config/`: `run.ts` auto-discovers
  `rules/*.rule.ts`, so dropping the file in is the registration.

## Concerns and limitations

- **CAVEAT (required by the task): this catches a shape, not a fact.** The rule proves that a
  file does not simultaneously fake fetch and enable an evidence write. It cannot prove — and no
  static rule can — that an evidence write in a *passing* file was actually preceded by a genuine
  network call. A test could delegate to real `fetch`, ignore the result, and still record
  evidence; this rule would pass it. Stated plainly in both the rule header and the README.
- **Known evasions (false negatives, deliberate).** The `isCI: true` arm requires the fake and the
  gate to sit in the same object literal, which is the shape all our adapter factories take; a
  factory taking them as separate positional arguments would slip through. A fake obtained from
  another module (imported test double) rather than minted in-file is also invisible — the rule
  is syntactic and single-file by the harness's contract (no `getType()`).
- **One shape it will flag that is arguably innocent:** a future test that mocks fetch, passes
  `isCI: true`, and asserts that *no* evidence row is written on a failure path. I judged that
  acceptable rather than narrowing further — under the invariant, an adapter fed a fake transport
  should not be handed an open evidence gate at all, and the remedy (assert the adapter's
  behaviour without forcing `isCI`) is straightforward. Flagging it is a design statement, not a
  misfire; raising it here so the auditor can disagree.
- The rule adds three descendant scans per in-scope file. `pnpm arch:check` wall time is 6.5 s
  over 2031 files with 12 rules — no measurable regression.

## Confidence

**High.** The predicate was chosen empirically against all three named ground-truth files (real
bytes, not paraphrases) and then against the whole current repo via `arch:check`; the candidate
population for a false positive was enumerated by hand (`isCI: true` files ∩ fetch-anchored
`vi.*` files = ∅) rather than assumed. All three scoped checks are green and the rule file is at
100% coverage on every metric.
