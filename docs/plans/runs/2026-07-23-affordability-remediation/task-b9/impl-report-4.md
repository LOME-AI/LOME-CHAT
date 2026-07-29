# B9 — audit findings closed: the gate now inspects what it claims to

**STATUS: DONE.** Both findings fixed. The latent gate hole is closed with the widening the
auditor measured, verified independently and demonstrated red in the previously-unscanned
region; the run identifier is gone.

## Files changed this cycle

| file | why |
| --- | --- |
| `packages/config/arch/run.ts` | `SOURCE_GLOBS` takes the api tree whole (`apps/api/src/**/*.ts`) instead of an enumerated directory list. |
| `packages/config/arch/rules/money-internals-owners-only.rule.test.ts` | test name names the reason, not the lane. |

## Finding 1 [Important] — the rule's stated reach now matches its actual reach

**Verified before taking the fix**, as instructed. The old glob list fed only
`apps/api/src/{slices,lib,middleware}/**` plus `app.ts`:

```
$ find apps/api/src -name '*.ts' | wc -l                                    → 1000
$ find apps/api/src/{slices,lib,middleware} -name '*.ts' | wc -l            →  862
```

862 + `app.ts` = 863 inspected, **137 never seen** — `platform/**`, `adapters/**`, `jobs/**`,
`smoke/**`, `workers-validation/**`, and the root-level `app-*.integration.test.ts` /
`scheduled.ts` / `entry.ts`. My rule gated on `filePath.includes('apps/api/')` and its docblock
said "Scope is `apps/api`", so the criterion "importing one anywhere else in `apps/api` fails
the gate" was false across that region. The finding reproduces exactly.

**The fix, and why it is a replacement rather than an addition.** The three narrower api globs
are strict subsets of `apps/api/src/**/*.ts`, so I collapsed them into it rather than leaving
redundant entries a later reader would have to reason about. That the two forms are equivalent
is not asserted — it is measured: the auditor's add-only change produced **2183** files and so
does this one.

```
$ npx tsx packages/config/arch/run.ts
arch:check: OK — 13 rule(s) over 2183 file(s)          EXIT=0
```

**2046 → 2183 files (+137), all 13 rules green, exit 0.** No collateral: every other rule
already gates itself to its own subtree inside `check`, which the widening does not disturb.
The `_template` exclusion is kept.

**Shown red in a directory that was previously invisible.** The coordinator's own example —
`platform/dev/seed-billing-history.ts`, which drives `runSettlement` with a `SettlementTx` and
writes nano-USD ledger legs:

```
$ npx tsx packages/config/arch/run.ts
EXIT=1
arch:check: ARCHITECTURE RULE VIOLATIONS
apps/api/src/platform/dev/seed-billing-history.ts:1 [money-internals-owners-only]
  '@hushbox/shared/affordability/estimate/reducers' is a money-layer internal. …
```

Under the old globs this file matched none of `slices/**`, `lib/**`, `middleware/**`, `app.ts`,
so the identical import would have passed silently — that is conclusive from the glob list
itself, not a second measurement.

**Reverted byte-exact**: `diff` clean, sha256 `c07b7966…bd` identical before and after, probe
import absent, `arch:check` green at 2183. The mutated file's own suite passes (4 tests, exit 0),
so the revert is verified by behaviour as well as by hash.

**The run.ts comment now states the rule rather than the list.** It records why the tree is
taken whole — an enumerated list silently exempts whatever it does not name, and `platform/dev`
writes ledger legs and wallet state — so the next person to add a directory does not have to
notice a glob file to stay covered.

**No live violation existed and none was introduced**: all reaching files remain under
`slices/`. This was a latent hole, and it is now closed rather than documented.

## Finding 2 [Minor] — run identifier in a test name

`money-internals-owners-only.rule.test.ts:111` read:

> `ignores files outside apps/api — apps/web is E1/G2 territory, the module is its own`

Now:

> `ignores files outside apps/api — apps/web is out of this rule's scope, the module is its own`

The correction names the reason instead of the lane, which is the durable form: "E1/G2
territory" stops meaning anything the moment the run closes, while "out of this rule's scope"
stays true.

**The irony is worth recording rather than glossed.** In the same cycle I stripped two `G1`
labels from `integration-setup.ts` for exactly this violation and then introduced a fresh
instance in a file I was authoring. Removing an instance is a task; not writing one is a habit,
and the constraint being in hand did not transfer from the file I was editing to the file I was
creating.

**So I swept instead of spot-fixing.** All ten files I have authored or edited across this
task, grepped for `A1`–`G9`, `T<n>`, `lane X`, `task X`, `§X<n>`:

```
$ for f in <the ten files>; do grep -nE '\b([A-G][0-9][a-z]?|T[0-9]+)\b|lane [A-G]|…' "$f"; done
[sweep complete]     ← no output
```

**Nothing else found.** The filter excludes `B + H`, which is the reasoning-budget identity and
not an identifier.

## Self-gate

| command | result |
| --- | --- |
| `npx tsx packages/config/arch/run.ts` | **pass** — OK, 13 rules over **2183** files, exit 0 |
| same, with a walled import in `platform/dev/seed-billing-history.ts` | **fail as designed** — exit 1, flagged at line 1; reverted byte-exact (sha256 match) |
| `vitest run` (`packages/config`, full) | **pass** — 31 files / 381 tests, exit 0 |
| `vitest run apps/api src/platform/dev/seed-billing-history.integration.test.ts` | **pass** — 4 tests, exit 0 (confirms the revert by behaviour) |
| `npx eslint arch` from `packages/config` | **pass** — exit 0, after the last edit, status captured on the command |
| `npx turbo typecheck --force --continue` | **pass** — 16/16, 0 cached, exit 0, after the last edit |

`apps/api` and `packages/shared` were not edited this cycle — the only api file touched was the
probe, reverted byte-exact — so their suites and lint stand as recorded in report 3.

## Deviations

- **`run.ts` is the harness, and its README says never to edit the harness to add behaviour.**
  This edit adds none: it changes which files the harness *sees*, not what any rule does. Noting
  it because the README sentence could otherwise read as prohibiting the ruled fix.
- The docblock on the rule needed no change: "Scope is `apps/api`" was the *false* half of the
  finding, and widening the globs makes it true rather than requiring it to be narrowed.

## Concerns and limitations

Carried forward unchanged from report 3, none of them touched this cycle:

- **The laundering gap** — `trial-smart-model-candidates.ts` is a price owner with zero walled
  specifiers, reaching an internal through an owner's re-export. Recorded in the plan with its
  shape named.
- **`packages/config/arch/README.md`** still under-describes the rule set; `.md` is read-only to
  me and the coordinator is carrying it with the doc batch. The widened glob is a second thing
  that file now under-describes.
- **`apps/web`** still has open reaches and no rule enforcing its stricter obligation.

No new work was taken beyond the two findings, per the standing instruction.

## Confidence

**High.** The hole was reproduced from the file counts before the fix was applied, the fix
reproduces the auditor's exact figure (2183) by an independent route, the gate was watched red
in the specific region that was previously invisible, and the revert is verified by hash *and*
by the mutated file's own passing suite. The identifier sweep covers every file I have touched
in this task, not only the one the audit named.
