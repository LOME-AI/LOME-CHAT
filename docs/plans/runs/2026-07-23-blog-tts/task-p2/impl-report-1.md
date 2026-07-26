# P2 — blog component: paused state, label cycle, highlight retention

## Objective

The blog reader's single control cycles Listen → Pause → Resume, the paused sentence stays
painted, Escape pauses, and the click that starts or resumes a read restarts an AudioContext the
browser has stopped — in the gesture, before any await.

## Files changed

- `packages/ui/src/components/blog-reader/blog-read-aloud.tsx` — `paused` UI status; the
  transport control's label/action table; `handlePause`/`handleResume`; the `paused` branch and a
  compile-time exhaustiveness default in `applyReaderState`; Escape pauses; `primeAudioContext`
  resumes a non-running context.
- `packages/ui/src/components/blog-reader/blog-read-aloud.test.tsx` — 14 new tests, 3 existing
  tests amended (below). Fake reader gains `pause`/`resume`; fake AudioContext gains
  `state` + `resume`.

Nothing else was touched. `document-reader.ts` was read, never opened for edit.

## Label / state mapping

| UI status | Visible label | Accessible name | Icon | Action |
| --- | --- | --- | --- | --- |
| `idle` (and `error`) | Listen | Listen to this post | Play | `handleStart` |
| `loading` | Stop | Stop | Square | `handleStop` |
| `speaking` | Pause | Pause | Pause | `handlePause` |
| `paused` | Resume | Resume | Play | `handleResume` |

`idle` keeps its existing pair verbatim (criterion 1's "unchanged"); the visible label is
contained in the accessible name, so WCAG label-in-name holds. `loading` is unchanged from
today, per criterion 6 — the model download has no cancel, so stopping is all that state can
offer. There is no Stop control in any other state: the founder ruling is one button, and the
recorded consequence is that only leaving the page (Astro MPA) or unmount resets a read to the
top.

## Proof the pause path cannot drop the resumed read

`handlePause` is three lines: `readerRef.current?.pause();`. It does **not** touch `runIdRef`,
`readerRef`, `highlighterRef`, `lastChunkRef`, or call `reader.stop()` — deliberately nothing
like `handleStop`, which does all five.

The guard test is `keeps the reader connected across a pause, so the resumed read still paints`:
it clicks the real Pause control, clicks the real Resume control, then delivers `onState('speaking')`
and a second `onChunk` from the same captured reader options, and asserts the chunk was
highlighted, `reader.resume()` was called, and the control is back to Pause. Every one of those
assertions is downstream of `live()`, so a bumped run token silently fails all of them.

Mutation-proven (source restored from a byte-for-byte backup after each; `grep -c MUTANT` = 0):

| Mutation to `handlePause` | Result |
| --- | --- |
| `runIdRef.current += 1` | `keeps the reader connected…` FAILS (no highlight, control stuck on Resume) |
| add `reader.stop()` + null `readerRef` + null `highlighterRef` | 3 tests FAIL: `pauses the reader when the control is clicked…`, `keeps the reader connected…`, `pauses rather than stops on Escape…` |
| null `readerRef` only | 2 tests FAIL: `keeps the reader connected…` (resume never reaches the reader), `stops the reader on unmount while paused` |

That last mutant survived my first draft of the unmount test, which reached `paused` through the
`onState` callback instead of the control; both tests were strengthened (click the real Pause
button; assert `reader.resume` was called) until it died. Reported because the first version
would have passed an audit while proving less than it claimed.

**No double stop:** `pauses the reader when the control is clicked while speaking` asserts
`reader.pause` called once and `reader.stop` **never** called. P1's contract is that pausing
already stops the engine once, and `stop()` from `paused` would zero the cursor and destroy the
resume point.

## How `lastChunkRef` survives the pause

`applyReaderState` gains a `paused` case that only calls `setStatus('paused')` — no
`lastChunkRef.current = null`, no `highlighter.clear()`. The existing `readingHighlight` effect
then does the rest unchanged: it repaints from `lastChunkRef` when the toggle goes on and clears
when it goes off.

Both retention tests were green before the change (P1 left `'paused'` falling through the switch
as a no-op), so they were validated by mutation instead: routing `paused` into the
`idle`/`stopped` clearing branch fails `leaves the paused sentence highlighted` and
`repaints the paused sentence when highlighting is toggled off and back on`.

## Exhaustiveness check (orchestrator ruling, mid-task)

`applyReaderState`'s switch gains:

```ts
default: {
  const unhandled: never = next;
  return unhandled;
}
```

Proven to bite: deleting the `case 'paused'` block makes `tsc --noEmit` fail with
`error TS2322: Type '"paused"' is not assignable to type 'never'` — the compile error that did
not exist when P1 widened `DocumentReaderState`. The `const … : never` form (rather than
`next satisfies never`) is used because it is the form the repo's lint config tolerates; the
value is returned rather than discarded because `noUnusedLocals` rejects an unread local even
under the `^_` lint exemption (observed: `TS6133` on the first draft).

Cost: those two lines are the file's only uncovered statements (unreachable by construction).

## The folded-in in-gesture `ctx.resume()`

`primeAudioContext` now runs `if (ctx.state !== 'running') void ctx.resume();` as its first
statement, before the silent-buffer prime and well before the dynamic import. Both entry points
call it, so there is one unlock implementation, not two:

- **start path** — `restarts a non-running context inside the click, before the import resolves`
  asserts `ctx.resume` was called with *nothing awaited* between `fireEvent.click` and the
  assertion, and that `createDocumentReader` has not yet been called. Same shape as the existing
  prime-ordering test.
- **resume path** (orchestrator addition; the reader's `resume()` takes no context and touches
  none) — `handleResume` calls `primeAudioContext(audioCtxRef.current)` before
  `void reader.resume()`. `restarts an interrupted context inside the resume click, before the
  reader resumes` sets the context back to `suspended` (what backgrounding the tab leaves), clicks
  with `fireEvent`, and asserts synchronously that `ctx.resume` ran **and** that its
  `invocationCallOrder` precedes `reader.resume`'s.
- `leaves an already-running context alone on a later listen` covers the `state === 'running'`
  arm.

`void ctx.resume()` is deliberately not wrapped in a catch: the only way a real `resume()` rejects
is a closed context, which this component never closes, and an unhandled rejection is a louder
signal than a swallowed one.

## Escape

`speaking` → pause; `loading` → stop (today's behavior, since a load cannot be paused);
`paused` and `idle` → nothing. Tests: `pauses rather than stops on Escape while speaking`,
`ignores Escape while paused`, `stops on Escape while the model loads` (renamed existing),
`ignores Escape while idle` (existing), plus `ignores keys other than Escape while speaking`
(uses `a{ArrowDown}` — Space/Enter activate the focused control by design, which the first draft
of that test tripped over).

## Layout

Unchanged. No element added or removed, no class touched anywhere in the returned tree; the only
render-side change is which icon/label/`aria-label`/handler the one existing button carries. The
band's height is therefore byte-identical across all states. The pill's *width* still varies with
its label ("Listen" / "Stop" / "Pause" / "Resume"), exactly as it already did between "Listen" and
"Stop" — the research doc's fixed `min-w` belonged to the two-segment U2 control the founder
ruled out, and adding one now would change idle rendering, which criterion 8 forbids. Flagged
rather than decided.

## Tests added

| Test | Behavior | Criterion |
| --- | --- | --- |
| `labels the control Pause while speaking` | visible + accessible name are "Pause" | (1) |
| `pauses the reader when the control is clicked while speaking` | `pause()` once, `stop()` never | (1)(2) |
| `labels the control Resume once the reader reports paused` | name/label "Resume" | (1) |
| `resumes the reader when the control is clicked while paused` | `resume()` once | (1) |
| `keeps the reader connected across a pause, so the resumed read still paints` | run token + refs survive; resumed chunk paints | (2) |
| `leaves the paused sentence highlighted` | no `clear()` on entering `paused` | (3) |
| `repaints the paused sentence when highlighting is toggled off and back on` | clears, then repaints the *same* span | (3) |
| `pauses rather than stops on Escape while speaking` | `pause()` once, `stop()` never | (4) |
| `ignores keys other than Escape while speaking` | non-Escape keys do nothing | (4) |
| `ignores Escape while paused` | no pause, no stop, still "Resume" | (4) |
| `stops the reader on unmount while paused` | exactly one `stop()`, from the teardown | (5) |
| `restarts a non-running context inside the click, before the import resolves` | in-gesture `ctx.resume()` on start | (7) |
| `restarts an interrupted context inside the resume click, before the reader resumes` | in-gesture `ctx.resume()` on resume, ordered before `reader.resume` | (7) |
| `leaves an already-running context alone on a later listen` | the `running` arm | (7) |

Ten of the fourteen were watched RED before any source edit, each for the expected reason: no
`Pause`/`Resume` button in the tree, `ctx.resume` never called, `expected 'suspended' to be
'running'`, and Escape calling `stop` where `pause` was asserted. The four that could not fail
first (`paused` fell through P1's switch as a no-op today) are mutation-proven above.

### Amended existing tests

- `hides the download bar once speaking begins` — asserted the Stop control was present after
  `speaking`; now asserts the Pause control. The old assertion pinned exactly the behavior this
  task replaces.
- `stops the reader and returns to idle when Stop is clicked` → `…when Stop is clicked during the
  load`: dropped the `onState('speaking')` line so it pins stop-from-`loading`, which is the state
  that still offers Stop. Stop-from-`speaking` no longer exists.
- `stops on Escape while active` → `stops on Escape while the model loads`: same reason, name made
  honest. Body unchanged.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm exec vitest run --coverage` (from `packages/ui`) | pass — 94 files, 1893 tests, 0 failures, no threshold error |
| `pnpm exec tsc --noEmit -p tsconfig.json` | pass (clean) |
| `npx turbo typecheck lint --filter=@hushbox/ui --force` | pass (2/2 tasks) |
| `pnpm exec eslint <both owned files>` after the final edit | exit 0 |
| `npx jscpd --threshold 2` on owned files | 0 clones, 0% duplicated |

Per-file coverage for `blog-read-aloud.tsx` (from `coverage-final.json`, scoped run):
statements 142/144 (98.61%), branches 44/45 (97.78%), functions 36/36 (100%). The single
uncovered statement pair and branch is the unreachable exhaustiveness `default`.

The first two coverage runs died on the known Vitest ENOENT
(`Something removed the coverage directory … coverage-<n>.json`) when pointed at a scratchpad
`reportsDirectory`; using the package's default `coverage/` (gitignored) it ran clean, twice.

One lint round-trip after the final edit produced two errors — a `prettier/prettier` line-length
break in the transport table and `unicorn/no-useless-undefined` on `mockResolvedValue(undefined)`
— both fixed, then eslint exit 0.

## Deviations

None from the acceptance criteria. Two judgment calls, stated rather than hidden:

- `handleResume` reuses `primeAudioContext` wholesale instead of extracting a narrower
  "resume if not running" helper. It gives one unlock implementation for both gestures with no
  unreachable null branch; the cost is one extra silent buffer per resume, which is what a second
  Listen already does.
- Escape while `paused` is a no-op. The criteria only specify Escape-pauses-while-speaking, and
  the founder ruling removed Stop from the UI, so there is nothing else for it to do; `research/pause-resume.md`'s
  "Esc while paused stops and clears" belonged to the superseded two-control design.

## Concerns and limitations

- With Stop gone from `speaking`/`paused`, a reader who wants to restart from the top must
  reload the page. Founder-accepted and recorded in the plan's rulings, noted here only so the
  audit does not re-derive it as a gap.
- The pill's width still changes with its label (pre-existing; see Layout).
- `status` is the only thing gating what the control does; a `paused` read whose reader has
  somehow been released would no-op on `?.`. That state is unreachable — only `handleStop` and a
  failed start release the reader, and both leave `status` outside `paused`.

## Confidence

High — every criterion has a test, the highest-risk behavior (the run token surviving a pause) is
pinned by a test proven to die under three separate mutations, the exhaustiveness guard was proven
to produce a real compile error, the full `@hushbox/ui` suite is green, and per-file coverage clears
all four thresholds with the only gap being code that is unreachable by construction.
