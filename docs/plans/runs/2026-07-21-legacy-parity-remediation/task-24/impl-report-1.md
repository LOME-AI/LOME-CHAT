# T24 impl-report-1

## Objective
Resolve the `'request completed'` log-`msg` lockstep smell between the emitter
(`apps/api/src/middleware/request-log.ts`) and the dev-stack heartbeat matcher
(`scripts/lib/heartbeat-source.ts`). Founder-ruled resolution (after the round-1 blocker
below): ACCEPT the coupling as an honest documented parse contract — keep the emitter's inline
literal (redaction rule), keep the consumer const local, and reword the comment(s) to state the
true producer→consumer relationship. Do NOT touch the security lint rule.

## Round-1 blocker (resolved by founder ruling)
The original "hoist to one shared constant imported by BOTH" is impossible for the EMITTER: the
`redaction/logger-msg-literal` ESLint rule (`packages/config/eslint-extensions/rules/logger-msg-literal.mjs`)
rejects any non-literal first argument to `logger.info` **syntactically** within
`apps/api/src/middleware/`, so `logger.info(SOME_CONST, …)` fails lint (empirically: 1 eslint
error, 0 type errors — the `LiteralMsg` type accepts the const; only the syntactic lint rule
rejects it). `eslint-disable` on a redaction rule is banned. Founder ruled: accept the coupling
+ precise comment; do not edit the lint rule. This report implements that ruling.

## Files changed
- `apps/api/src/middleware/request-log.ts` — added a producer-side comment above the (untouched)
  `logger.info('request completed', …)` call documenting that the `msg` is a PARSE CONTRACT read
  by dev-stack tooling, written inline (never a shared constant) because `redaction/logger-msg-literal`
  requires a syntactic literal. Call site and literal unchanged.
- `scripts/lib/heartbeat-source.ts` — reworded the `REQUEST_LOG_MSG` comment block: removed the
  "kept in lockstep" framing; now states this is a producer→consumer parse contract (the
  middleware is the sole producer, this tooling parses its stdout and keys on `msg`), and that the
  value is duplicated here rather than shared precisely because the producer's `msg` must be an
  inline literal per the redaction rule. The `REQUEST_LOG_MSG` const already existed (from T17);
  only its doc comment changed.

No `packages/shared` change (a shared const buys nothing — the emitter cannot reference it either
way — so the local const in the consumer is the simplest correct form, per the founder's stated
preference).

## Reworded comment (consumer, heartbeat-source.ts)
> This is a PRODUCER→CONSUMER parse contract, not two implementations of the same logic that must
> agree: the middleware is the sole producer of the log line, and this dev-stack tooling is a
> consumer that parses that stdout and keys on its `msg`. The value is duplicated here — not
> imported from a shared constant — because the producer's `msg` is intentionally an inline literal
> at its call site (the `redaction/logger-msg-literal` rule requires a syntactic literal so
> redaction can statically prove no content leaks), so the emitter cannot reference a shared
> constant. If the producer ever changes this literal it must update this consumer too, or the
> idle heartbeat and the mobile-test log slice silently stop recognizing traffic.

## Added comment (producer, request-log.ts)
> The `msg` below is a PARSE CONTRACT, not free text: dev-stack tooling reads this middleware's
> emitted stdout and keys on this exact literal — the idle heartbeat (heartbeat-source.ts) and the
> mobile-test log slice (extract-mobile-api-log.ts). It is written INLINE, never a shared constant,
> because the `redaction/logger-msg-literal` rule requires a syntactic string literal here (so
> redaction can statically prove no content leaks); the consumer names its own copy and documents
> the dependency direction.

## Tests added
None — this is a comment-only change with zero behavior change (the consumer const and matcher
logic are unchanged from T17). No production line was added, so TDD's "no production without a
failing test" is not triggered; the existing matcher test is the regression guard.

## Self-gate
- `eslint apps/api/src/middleware/request-log.ts` (from apps/api) — **pass**, exit 0. The
  redaction rule stays green because the emitter's call-site literal is untouched.
- `eslint scripts/lib/heartbeat-source.ts` (from scripts) — **pass**, exit 0.
- `tsc --noEmit` (apps/api and scripts) — **pass**; no errors on either owned file (comment-only
  changes cannot introduce type errors).
- `vitest run scripts/lib/heartbeat-source.test.ts` — **pass**, 9/9 tests green.

## Acceptance criteria
1. Eliminate the lockstep sync-contract smell — **met (per founder ruling)**: reframed as an
   honest, documented producer→consumer parse contract; the misleading "keep in lockstep" wording
   is gone from both sides, replaced by a precise statement of the dependency direction and the
   redaction-rule reason the emitter can't share a constant.
2. Emitter's literal + redaction rule untouched/green — **met**: `logger.info('request completed', …)`
   unchanged (diff adds only a comment); `redaction/logger-msg-literal` passes, eslint exit 0.
3. Consumer names the matched literal as a const — **met**: `REQUEST_LOG_MSG` (local, pre-existing)
   is the named const the matcher keys on.

## Deviations
Departs from the brief's original "one shared constant imported by both" — impossible under the
redaction lint rule (round-1 blocker), superseded by the founder's accept-the-coupling ruling.
No `packages/shared` const added (see Files changed).

## Concerns and limitations
The `heartbeat-source.ts` git diff vs HEAD is large because the file was already modified
(uncommitted T17 work: the `[req]`→structured-JSON matcher rewrite) before this task began — it
was `M` in the starting `git status`. My change is only the `REQUEST_LOG_MSG` comment block.

## Confidence
high — comment-only change implementing an explicit founder ruling; all self-gates green, emitter
call site and redaction rule verified untouched.
