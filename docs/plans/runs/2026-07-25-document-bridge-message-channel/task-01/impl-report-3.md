# T1 fix round 3 — the file header's trust paragraph

## Objective

One item, comment-only: the file header of `apps/sandbox/src/render/bootstrap.ts` opened with "The
embedding app is never trusted", while the intake comment fixed in round 2 states that the channel's
holder is already trusted. Each is true in its own sense — containment vs. authentication — but the
file is where the trust model must read as one account. Bring the header into line with the model the
file now implements, keeping what remains true in it.

## Files changed

| Path | Why |
| --- | --- |
| `apps/sandbox/src/render/bootstrap.ts` | Header trust paragraph rewritten so the file gives one account of who is trusted, what the shape parse is for, and what containment rests on. Comment text only; no statement changed. |

No other file was touched, and no bundle was regenerated (see §Bundle drift).

## The edit

**Before** (lines 29–32):

```
 * The embedding app is never trusted: inbound messages are validated by shape
 * (not by the sender's origin, which may be `capacitor://localhost`).
 * Containment is the opaque sandbox origin itself, enforced by the frame's
 * attributes and CSP.
```

**After** (lines 29–38):

```
 * Trust here rests on one thing: possession of the port. The embedder is the
 * party this frame answers to, and holding the other end of the channel minted
 * below is what makes it that party — there is no other intake. No origin is
 * checked anywhere, because there is none to check: a port message carries no
 * sender origin, and an opaque frame cannot learn its embedder's (it is
 * `capacitor://localhost` on mobile). Inbound messages are still validated by
 * shape, but that is payload validation, not authentication. The untrusted
 * party is the document code this frame runs; it is contained by the opaque
 * sandbox origin itself — the frame's attributes and CSP — never by a check at
 * this intake.
```

What carried over, unchanged in substance: messages **are** shape-validated; no origin **is** checked
(and the `capacitor://localhost` reason survives, now stated as *why there is nothing to check*
rather than as a checkable thing declined); containment **is** the opaque sandbox origin, enforced by
the frame's attributes and CSP.

What changed is only the subject of each claim. The old paragraph attached distrust to the embedder
and left shape validation as the apparent security mechanism. The new one names the three roles
separately — the embedder is trusted by possession of the port, the shape parse guards the payload,
the document code is the untrusted party and is held by the origin — so the intake comment at
:534-539 is now the local detail of the same model rather than a second, opposing account.

The paragraph below it (the `MessageChannel` transport docblock) needed no change: it already
explained why the port is forced and why it is the stronger boundary, and it now reads as the
mechanism behind the header's first sentence.

## Bundle drift — confirmed, not assumed

Comments are stripped by the minifier, so no rebuild should have been needed. Verified rather than
asserted:

```
✓ src/render/build-bundle.test.ts (4 tests) — 4 passed
```

Those four include `keeps the committed public/render.js in sync with the source` and
`writeRenderBundle rewrites the committed bundle from source` — the second **writes** the bundle from
the edited source, so it is a real rebuild, not just a comparison. `public/render.js` md5 before and
after that run:

```
2ae5a70d8b315ee871161b9b9ae51739  public/render.js   (before)
2ae5a70d8b315ee871161b9b9ae51739  public/render.js   (after)
```

Byte-identical, so the committed bundle was genuinely unaffected and the `toBe()` drift assertions
stayed green on their own. A grep of `public/render.js` for `never trusted`, `possession of the port`,
and `payload validation` returns 0 hits — neither the old nor the new text reaches the bundle,
matching round 2's finding.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm exec tsx ../../scripts/with-env.ts vitest run src/render/build-bundle.test.ts` | pass — 4 tests (drift, incl. the rebuild-and-compare) |
| `pnpm exec tsx ../../scripts/with-env.ts vitest run src/render/` | pass — 5 files, 64 tests |
| `pnpm --filter @hushbox/sandbox test` | pass — 17 files, 159 tests; coverage 100% st/br/fn/ln |
| `npx turbo typecheck --filter=@hushbox/sandbox --force` | pass — 1 successful, 1 total |
| `pnpm exec eslint src/render/bootstrap.ts` (from `apps/sandbox`, after the final edit) | exit 0 |

Counts are identical to round 2's (159 tests, 100% coverage), as a comment-only edit requires.

## Constraint compliance

- **Comment-only.** The single edit replaced one contiguous comment block. No statement, expression,
  or declaration changed.
- **A7 — `reportReactFailure` and the `reactFailureReported` guard untouched.** They live at
  :98/:155/:181-188/:410; the edit was at :29-32, hundreds of lines away and inside a docblock. Their
  ordering relative to the `pendingRequestId === requestId` settle branch is exactly as it stood at
  round start.
- **Global Constraint 9 — no plan or run identifiers.** The new text names no task, run, or
  amendment, and does not narrate the change.
- **Global Constraint 8.** Satisfied without a rebuild, proven by the drift tests above rather than
  by assumption.

## Acceptance criteria (this round)

1. **Met.** The header no longer says the embedder is never trusted; it states what the port's
   possession establishes, what shape validation is for, and what containment rests on — a single
   coherent picture with the intake comment.
2. **Met.** Everything still true in the old paragraph is preserved: shape validation, no origin
   check (with its `capacitor://localhost` reason), containment by the opaque sandbox origin.
3. **Met.** Comment-only; drift tests green with a byte-identical bundle.

Round 2's three items and the eight original T1 criteria are untouched and remain met.

## Deviations

None.

## Concerns and limitations

The new header and the intake comment at :534-539 both state that a port message carries no sender
origin. That is deliberate overlap of one fact at two altitudes (the model, then the local reason the
parse is not authentication), not two accounts of it — but if a future reader wants the file leaner,
that sentence is the one line that could be dropped from the intake without loss.

## Confidence

**High.** The change is a comment rewrite whose correctness is checkable by reading it against the
code it describes, and the one empirical claim in the brief — that no rebuild is needed — was
measured (identical md5 across a test that rewrites the bundle) rather than assumed.
