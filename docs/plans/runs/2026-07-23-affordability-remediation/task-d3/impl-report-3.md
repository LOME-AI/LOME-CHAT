# D3 — impl report 3 — one comment corrected

## Objective

Replace the wrong comment at `apps/api/src/slices/models/domain/estimate-run.test.ts:1291`, which
described the loop fixture's `body` node as "the only sink". Change nothing else — no assertion, no
fixture, no production file.

## Files changed

| file | why |
| --- | --- |
| `apps/api/src/slices/models/domain/estimate-run.test.ts` | One comment replaced. The old text used the codebase's `sink` vocabulary to say the opposite of what the interpreter does, beside an exact nano assertion. |

## The change

**Before** (one line, at the head of the `bodyStorage` computation):

```ts
// `body` runs twice and is the only sink, so it alone carries output storage.
```

**After:**

```ts
// Only `modelCall`/`smartModel` nodes carry an output-storage term, and the
// reserve applies it to every unconsumed producer — `body` is the only
// unconsumed node of that class, priced over the loop's iteration count.
// The run never persists that value: a loop's body is child-driven, and the
// sink predicate excludes child-driven nodes. The reserve is therefore
// generous here, in the safe direction.
```

The old wording is gone repo-file-wide: `grep -c "is the only sink"` on the file returns **0**.

### Why the old text was wrong, verified in code

- `interpreter.ts:385-389` — `childDriven` is built from every `fanOut` / `loop` node's `body`
  field, so `body` is child-driven for the whole run.
- `interpreter.ts:1073-1076` — `isSink` requires `!this.childDriven.has(nodeId)`. `body` is
  therefore **never** a sink, and `sinkOutputs()` never persists it. The unconsumed node in the
  fixture is `l1` (the loop's own `out` is read by nobody; `l1.state` is a virtual port, so the
  derivation does not count `l1` as consumed).
- `estimate-run.ts:674,693` — only the `modelCall` and `smartModel` arms call
  `outputStorageContextFor`; `l1` is a `loop` node and contributes no storage term. So the term in
  the assertion belongs to `body` for a reason unrelated to sinks: it is the only **unconsumed
  `modelCall`**.

The comment now states the mechanism (the two node classes that carry the term; the unconsumed-producer
rule; child-driven exclusion from the sink predicate) rather than this fixture's arithmetic. The
`2n` factor is described as "the loop's iteration count", not re-derived numerically.

**Money unaffected**, as the finding said: a body-node reserve is an over-reserve in the safe
direction (`reserve ⊇ bill` holds), and a loop node carries no charge.

## Tests added

None — and none is possible. The change is a comment; no assertion, fixture, name or executable line
moved, so there is no behaviour a test could watch go red. The TDD cycle has no purchase on a
comment. The existing suite is the regression check that nothing else moved (below).

## Self-gate

| command | result |
| --- | --- |
| `npx vitest run src/slices/models/domain/estimate-run.test.ts` (from `apps/api`, in isolation) | **pass — `EXIT=0`, 1 file, 79/79 tests** |
| `npx eslint src/slices/models/domain/estimate-run.test.ts` (from `apps/api`, after the final edit) | **pass — `EXIT=0`, no output** |

Both statuses were captured on the command itself (`cmd > log 2>&1; echo "EXIT=$?"`), not through a
pipeline, per Global Constraint 9 and the brief's warning that the background harness has misreported
exit codes. `pnpm test:api` and `pnpm ensure-stack` were **not** run, per the brief — another agent's
api vitest may be live.

No typecheck run: the edit is inside a `//` comment, which cannot alter the program. The prior
cycle's repo-wide `turbo typecheck --force` result (16/16) stands over an otherwise identical tree.

## Acceptance criteria

**The comment is replaced with an accurate durable fact — met.** Before/after above; the three code
sites that make the old text wrong and the new text right are cited with line numbers, each read this
session.

**Nothing else changed — met.** Evidence:

- The edit was a single exact-string replacement of one line; the tool would have failed on a
  non-unique or non-matching target.
- The assertion and every nano figure in that test are byte-identical:
  `const bodyStorage = 2n * 1000n * BigInt(outputCharsPerTokenForTier('free')) * CHAR_RATE;` and
  `expect(estimateRun(loopFed)._unsafeUnwrap()).toBe(BASE_1000 + BASE_1000 * 2n + bodyStorage);`
  — both re-read after the edit. The fixture's three nodes and three edges are unchanged.
- The file's test count is **79**, the same set that ran green in the prior cycle; a deleted or
  renamed case would have moved it.

**No production file differs — met.** `ls --time-style=full-iso` on every file this task owns:

| file | mtime |
| --- | --- |
| `models/domain/estimate-run.test.ts` | **14:48:52** (this edit) |
| `models/domain/estimate-run.ts` | 14:05:32 |
| `workflows/compile/compile-definition.ts` | 14:02:07 |
| `workflows/engine/interpreter.ts` | 14:03:20 |
| `packages/shared/src/workflow.ts` | 14:28:37 |

Only the test file carries a mtime from this session. Every production file predates it by twenty
minutes or more — they are the prior cycle's, untouched here.

**`packages/shared/src/workflow.ts:147` left alone — met.** Confirmed as the close-phase batch's, per
the brief. Not read for edit, not modified (mtime 14:28:37, twenty minutes before this session's only
edit).

## Deviations, with reasons

None.

## Concerns and limitations

- **A comment cannot be pinned.** Nothing prevents this one from going stale again if the sink
  predicate or the storage-term node classes change. The mitigation available is the one taken: state
  the mechanism in the vocabulary the code actually uses (`childDriven`, the sink predicate,
  unconsumed producers), so the vocabulary sweep that Global Constraint's comment-drift note
  prescribes will find it if any of those names move.
- The comment names `smartModel` alongside `modelCall` although this fixture builds neither a
  `smartModel` nor any second class. That is deliberate — it is the durable rule (both arms call
  `outputStorageContextFor`), and stating it over the class is the same framing
  `outputStorageContextFor`'s own doc comment uses.

## Confidence

**High.** The scope is one comment; every factual claim in it was read out of the three cited code
sites this session rather than recalled; the file runs 79/79 green and lints exit 0 after the final
edit; and mtimes show no other file moved.
