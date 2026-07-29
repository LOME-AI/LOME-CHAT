# F4 — implementation report 4 (fix cycle 4)

## Objective

Close the single Minor from the verification audit: one stale field name inside one comment
in `apps/web/src/hooks/billing/use-turn-options.ts`. The comment described the served wire
shape as carrying `` `payer` and `tier` ``; the served field is `payerTier`. One word.

Nothing else was touched — no production statement, no test, no other comment, and not the
file's NUL byte (pre-existing at HEAD, owned by G12).

## Files changed

| File | Why |
| --- | --- |
| `apps/web/src/hooks/billing/use-turn-options.ts` | The comment above the single funding read named a wire field that no longer exists; it re-voiced the exact `tier`-versus-`payerTier` conflation this task's rename was ruled to eliminate, twelve lines above code that correctly reads `served.payerTier`. |

## The change, before and after

Exactly one line moved, at `:200`. One `Edit` call, one `old_string`, one occurrence.

Before:

```ts
  // ONE read. The conversation NAMES the payer, and the server has already
  // applied §Group Funding 2 — it returns the winning wallet's figures plus
  // `payer` and `tier`. Re-resolving that client-side was a second authority
  // for a decision the wire already carries, and it disagreed with the server
  // inside the settle-then-release window.
```

After:

```ts
  // ONE read. The conversation NAMES the payer, and the server has already
  // applied §Group Funding 2 — it returns the winning wallet's figures plus
  // `payer` and `payerTier`. Re-resolving that client-side was a second authority
  // for a decision the wire already carries, and it disagreed with the server
  // inside the settle-then-release window.
```

The corrected name is the one the file's own code and its own wire type already use:
`ServedFunding` is declared at `:188` as
`{ spendableNanoUsd: string; heldNanoUsd: string; payerTier: UserTier; payer: 'self' | 'owner' }`,
and `fundingSnapshotOf` reads `payerTier: served.payerTier` at `:181`. The comment was the
only thing in the file still saying otherwise.

## Tests added

**None, and the absence is the point.** The change is a comment; no test can observe it, and
writing one that could would mean asserting on source text rather than behaviour. This is why
the auditor graded the finding **Minor** rather than Important: the compiler already corrects
any reader who acts on the stale name — `served.tier` does not typecheck against `:188`. The
protection is structural, so the fix restores accuracy without adding a gate. The two Important
findings the panel raised earlier described behaviour no gate could correct; that is the
distinction between the grades, and it is the reason this cycle adds no pin.

## Sweep — binary-inclusive, on the file no earlier sweep could read

This file carries a raw NUL byte, so `ugrep` classifies it as binary and skips it without `-a`:
no match, no warning, exit 0 (§Known Breakage). Every sweep below ran with `-a`.

**Exhaustive sweep — every occurrence of the substring `tier`, case-insensitive
(`grep -ain "tier" apps/web/src/hooks/billing/use-turn-options.ts`), 9 hits, all of them:**

| Line | Text | Verdict |
| --- | --- | --- |
| 16 | `type UserTier,` | The shared type name. Correct. |
| 87 | `* ceiling comes from the shared tier authority so there is exactly one` | Prose noun, not a field. Correct. |
| 110 | `* tier. Omit for a solo composer or a picker opened outside a conversation.` | Prose noun. Correct. |
| 166 | `* none. The served snapshot also names the PAYER's tier, which is why an` | Prose noun, and true — the snapshot does name it, via `payerTier`. Correct. |
| 176 | `return { ...trialFunding(), payerTier: 'trial', payer: 'self' };` | Renamed field. Correct. |
| 181 | `payerTier: served.payerTier,` | Renamed field, both sides. Correct. |
| 188 | `\| { spendableNanoUsd: string; heldNanoUsd: string; payerTier: UserTier; payer: 'self' \| 'owner' }` | The wire type. Correct. |
| 200 | ``// `payer` and `payerTier`. Re-resolving that client-side…`` | **This cycle's fix.** |
| 210 | `// fallback is the tier conflation the guest's own door exists to remove.` | Prose noun. Correct. |

**Zero stale field references remain.** The four prose hits (87, 110, 166, 210) use "tier" as an
English noun, none of them naming a wire or struct field; the four code hits plus the fixed
comment all say `payerTier`.

A second, narrower sweep for the rename's removed vocabulary
(`\.tier\b|\btier:|` backticked/quoted `tier` `|callerTier|noEndpointFunding|useUserTierInfo`)
returns **no residue** — every hit is a `payerTier` or the `FundingSnapshot` type import. The
removed symbols `callerTier`, `noEndpointFunding`, and `useUserTierInfo` appear nowhere in the
file.

## Nothing else in the tree changed

- **One `Edit` tool call this cycle**, on one file, replacing one line. No `Write` to any source
  file, no scratch or temp file, no script. The only other file this cycle produced is this
  report, at its assigned path.
- `git diff --numstat -- apps/web/src/hooks/billing/use-turn-options.ts` → `58 39`, the
  cumulative diff against HEAD from cycles 1–4; within it the `:200` hunk shows the single
  `-`/`+` comment pair quoted above and no other change from this cycle.
- **The NUL byte is untouched.** Read back at the byte level in Node rather than through a
  tool that renders it: exactly **1** NUL, at offset **9558**, on **line 216** — its
  pre-existing HEAD position — in an 11,100-byte file. `Read`/`Edit` did not normalise or
  strip it. It stays G12's to remove.
- **No file outside my ownership was edited.** One untracked file exists under `apps/web`,
  `src/hooks/models/use-payer-premium-access.ts` — inside **F10's** territory, which the brief
  places out of bounds; it is a concurrent agent's, not mine.
- Read-only git throughout (`status`, `diff`, `show`). No state-writing command. No `.md` file
  read as anything but read-only.

## Self-gate

| Command | Result |
| --- | --- |
| `npx eslint src/hooks/billing/use-turn-options.ts`, run from `apps/web/` **after** the edit | **pass** — exit 0, no output. Prettier rides ESLint, so formatting is covered; the lengthened comment line needed no reflow. |
| `pnpm test:watch apps/web/src/hooks/billing/use-turn-options.test.ts` (the one file, in isolation, per brief) | **pass** — exit 0, 1 file / **30 passed / 30** |
| `npx turbo typecheck --filter=@hushbox/web --force` | **pass** — exit 0 (`tsgo --noEmit` ×2) |
| `pnpm test:web`, `pnpm test:api`, `pnpm ensure-stack` | **NOT RUN** — forbidden by brief; several agents are live and no two suites may share a coverage directory. Justified beyond the instruction: the only changed bytes are inside a `//` comment, so no suite's inputs moved. The isolated file run and the forced typecheck are the sound checks available. |

## Acceptance criteria

No criterion's behaviour changed this cycle; the finding was accuracy of the record, not
conduct of the code. Re-evidenced is the one criterion the stale comment sat under.

| Criterion | Status | Evidence |
| --- | --- | --- |
| `FundingSnapshot.tier` renamed **`payerTier`** everywhere, and the value served is the **payer's** | **met** | The exhaustive 9-hit sweep above: every field-position occurrence in this file reads `payerTier`, including the last prose reference to the wire shape. This was the final `tier` field name in the file's own account of itself. |

## Deviations, with reasons

None. The change is exactly the validated finding, one word, in the one place named.

## Concerns and limitations

1. **The sweep is file-scoped, deliberately.** The brief scoped this cycle to this file and
   this comment, so I did not re-sweep the repo for `tier`-versus-`payerTier` prose elsewhere.
   Cycle 3's binary-inclusive sweeps covered the rename's code surface; comment prose in other
   files was not re-examined this cycle and I make no claim about it.
2. **This class of staleness has no gate.** The compiler catches a reader who *acts* on the
   wrong name, which is what makes it Minor — but nothing catches the comment itself. The
   general defence is G12 removing the NUL so sweeps stop lying; until then, any comment-level
   vocabulary claim in this run's reports holds only where the sweep ran with `-a`.
3. **No E2E run** (Global Constraint 11).

## Confidence

**High.** One word, in one comment, in one file; the corrected name verified against the wire
type and the reading code in the same file; an exhaustive binary-inclusive enumeration of every
`tier` substring showing zero residue; lint, isolated test, and a forced typecheck all green
after the final edit; and the NUL byte confirmed byte-identical in position and count.
