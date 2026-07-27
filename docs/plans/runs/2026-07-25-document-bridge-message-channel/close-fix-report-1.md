# Close-out fix batch — report 1

## Objective

Two comment/prose corrections that this run's transport change made false. No behaviour
change, no code change. Global Constraint 1 (schemas frozen) applies to the Zod
definitions; only prose was touched.

## Files changed

- `docs/DOCUMENTS.md` — narrowed the bridge-protocol transport-agnosticism claim to the
  Zod definitions, so the claim is no longer disproved by opening the cited file.
- `packages/shared/src/documents/bridge.ts` — comments only: header block and the
  `parseParentToFrameMessage` doc comment, both of which still described the superseded
  window/origin transport.

## Fix 1 — `docs/DOCUMENTS.md` (§Bridge protocol)

**Before**

```
the same schemas. The schemas are transport-agnostic — they describe message shapes and
name no window, origin, or port — so the transport below is free to change without
touching them.
```

**After**

```
the same schemas. The Zod definitions themselves are transport-agnostic — they constrain
message shape and carry no window, origin, or port concept — so the transport below is
free to change without touching them.
```

The load-bearing half (transport changed without touching the schemas — proven by this
run) is preserved. The parenthetical now scopes to the Zod definitions, which is
checkable and true; the file's comments do discuss transport, and previously a reader
opening `bridge.ts` disproved the sentence.

## Fix 2 — `packages/shared/src/documents/bridge.ts`

### 2a — header block (was :3-15)

**Before**

```
/**
 * The wire protocol between the app (parent window) and the sandbox-origin
 * iframe that renders and runs untrusted document code. Defined once here and
 * imported by both sides: the app never re-types these shapes, and the renderer
 * pages validate every inbound message against the same schemas. Message
 * identity is carried by a `type` discriminant so a single `message` listener
 * can route without inspecting other fields.
 *
 * The parent origin is never trusted: the renderer validates message *shape*
 * with these schemas and does not authenticate the sender by origin string
 * (the embedding shell may be `capacitor://localhost` on mobile). Shape
 * validation is the contract; origin is not part of it.
 */
```

**After**

```
/**
 * The wire protocol between the app and the sandbox-origin iframe that renders
 * and runs untrusted document code. Defined once here and imported by both
 * sides: the app never re-types these shapes, and the renderer pages validate
 * every inbound message against the same schemas. Message identity is carried
 * by a `type` discriminant so one intake can route without inspecting other
 * fields.
 *
 * Messages ride a `MessageChannel`: the frame mints it and transfers one port
 * to its embedder on a one-shot `ready` broadcast, and all later traffic in
 * both directions goes over that port — the frame registers no `window` message
 * listener. Possession of the port is therefore the authority. A port message
 * carries no sender origin to check (`event.origin` is always empty), and an
 * origin string could not serve as the check in any case: a sandboxed frame's
 * origin is opaque and the embedding shell may be `capacitor://localhost` on
 * mobile. These schemas validate payload shape; they are not authentication.
 */
```

Falsehoods removed: "(parent window)" as the transport peer; "a single `message`
listener" (the frame has none); "does not authenticate the sender by origin string",
which implied an origin string was available to decline.

Each new claim verified against the tree:

| Claim | Evidence |
| --- | --- |
| Frame mints the channel and transfers one port on `ready` | `apps/sandbox/src/embedder-channel.ts:51,72-74` |
| Frame→embedder traffic rides the port | `embedder-channel.ts:75-77` |
| Embedder→frame traffic rides the port | `apps/web/src/components/document-panel/document-sandbox.tsx:474` (`portRef.current?.postMessage`) |
| `ready` is one-shot / first-wins | `document-sandbox.tsx:526-532` |
| Frame registers no `window` message listener | grep for `addEventListener('message'` across `apps/sandbox/src`: only `embedder-channel.ts:58` (port1), a local probe channel in `render/bootstrap.ts:213-214`, and `embed-harness.ts:79` (test harness). No bootstrap window listener. |
| Port messages carry no sender origin | `embedder-channel.ts:52-57` records the same fact |

### 2b — `parseParentToFrameMessage` doc comment (was :240-244)

**Before**

```
 * Validate an inbound parent→frame message. Returns a Zod safe-parse result and
 * never throws — the renderer must ignore anything it does not recognise rather
 * than fault on a stray `postMessage` from an unrelated source.
```

**After**

```
 * Validate an inbound parent→frame message. Returns a Zod safe-parse result and
 * never throws — the renderer must ignore anything it does not recognise rather
 * than fault on it. Whoever holds the port is already the trusted embedder, so
 * this guards against a payload the two sides disagree about, not an attacker.
```

"a stray `postMessage` from an unrelated source" cannot happen on a transferred port —
the frame has no window intake, so unrelated sources have no reach.

`parseFrameToParentMessage`'s comment (":251-253", "the app treats an unrecognised
message as noise") was left alone: the app *does* keep a `window` listener for the
handshake (`document-sandbox.tsx:549`), so noise is still real there and the comment is
still true. It was also outside the brief's list.

## Global Constraint 1 — schemas untouched (confirmed)

No Zod schema, exported type, or parse function body was modified. Verified
mechanically, not by eye:

```
git diff -U0 -- packages/shared/src/documents/bridge.ts \
  | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' | grep -vE '^[+-] \*' | grep -vE '^[+-]\s*$'
→ (empty)
```

Every added and removed line in the file is a ` * ` comment line. No constant array, no
`z.enum`/`z.object`/`z.discriminatedUnion`, no `export type`, and neither
`parseParentToFrameMessage` nor `parseFrameToParentMessage` signature or body changed.
`bridge.ts` is untracked-clean relative to HEAD apart from this batch (it was not among
the run-start modified paths), so the diff above is exactly this batch's delta.

No comment required a code change, so no escalation was needed.

## Self-gate

| Command | Result |
| --- | --- |
| `npx prettier --check docs/DOCUMENTS.md packages/shared/src/documents/bridge.ts` | pass — "All matched files use Prettier code style!" |
| `npx turbo typecheck lint --filter=@hushbox/shared --force` | pass — 2/2 tasks, 0 cached (cache bypassed) |
| `pnpm test:shared` | pass — 124 test files, 2970 tests; `src/documents/bridge.test.ts` 29/29; `bridge.ts` coverage 100/100/100/100 |
| `npx eslint src/documents/bridge.ts` from `packages/shared/` after the LAST edit | exit 0 |

## Deviations

None.

## Concerns and limitations

- `docs/DOCUMENTS.md` carries pre-existing uncommitted changes from this run's T5, so
  `git diff` against HEAD for that file shows ~98 lines that are not mine. My delta there
  is the single three-line edit quoted above.
- Flagged, not changed (out of scope by instruction): `docs/ARCHITECTURE.md:201` is
  stale for the same reason — it goes to the founder as a doc proposal.
- Nothing else was noticed that this batch left unfixed.

## Confidence

High — comment-only edits, every factual claim traced to a specific line in the shipped
transport, all four gates green with caches bypassed, and the schema freeze confirmed by
a mechanical diff filter rather than inspection.
