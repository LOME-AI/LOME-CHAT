# T20 impl-report-1 — R16 (client half): web regenerate builder sends `webSearchEnabled`

## Objective
The web regenerate request must include `webSearchEnabled` (mirroring the initial-send path)
so a regenerated search-backed answer stays a search answer end-to-end. The server half
(T07) already honors the field on regenerate; without this the intent was inert.

## Files changed
- `apps/web/src/hooks/chat/use-chat-stream.ts` — regenerate builder region (~line 512): added
  the conditional `webSearchEnabled` spread to the regenerate wire body, mirroring the
  send/paid builders exactly.
- `apps/web/src/hooks/chat/use-chat-stream.test.ts` — added two regenerate tests (present-when-on,
  omitted-when-off).

## Change detail
The regenerate builder already received the active state via `RegenerateStreamRequest.webSearchEnabled`
(interface field at line 103) — no threading was needed; the state was present but never
forwarded onto the wire body. Added:

```ts
...(request.webSearchEnabled === undefined
  ? {}
  : { webSearchEnabled: request.webSearchEnabled }),
```

This is byte-identical to the send builder's pattern (`buildTurnBody`, ~line 313) and the paid
builder's pattern (~line 510) — same source-of-truth value, same omit-when-undefined shape.

## Tests added
- `forwards webSearchEnabled on a regenerate when web search is on` — asserts
  `args.json['webSearchEnabled']` is `true` when the regenerate request sets `webSearchEnabled: true`.
  Covers acceptance: field present on regenerate request when web search is on.
- `omits webSearchEnabled on a regenerate when web search is off` — asserts the wire body has no
  `webSearchEnabled` property when the field is unset. Guards against unconditionally sending it
  (mirrors the send builder's omit-when-undefined semantics).

## Self-gate
- `pnpm test:watch src/hooks/chat/use-chat-stream.test.ts` (from apps/web) — pass — 40 passed (40).
- RED verification: before the source change, the "on" test failed at
  `expect(args.json['webSearchEnabled']).toBe(true)` (field absent) — the correct reason; the
  "off" test passed trivially (field never sent). After the change: 40/40 green.
- `npx eslint src/hooks/chat/use-chat-stream.ts src/hooks/chat/use-chat-stream.test.ts` (from apps/web,
  after the final edit) — exit 0.
- `pnpm typecheck` (apps/web, isolated) — one error only, in
  `apps/api/src/middleware/pipeline-bindings.ts(59,29): Cannot find name 'ExecutionContext'`.
  Pre-existing / concurrent-work failure: that file is NOT in my diff (`git diff --stat` shows my
  change set is exactly the two owned web files, +82 lines total). web compiles api transitively via
  project references, so the unrelated api error surfaces in web's typecheck run. No error originates
  in either owned file.

## Acceptance criteria
- Regenerate builder forwards the active `webSearchEnabled` state exactly as the initial-send
  builder does — MET (identical conditional spread; same `request.webSearchEnabled` source).
- A test proves the field is present on a regenerate request when web search is on — MET (plus a
  paired omit-when-off test).
- Surgical, regenerate builder only — MET (3 source lines; no other region touched).

## Deviations
None.

## Concerns and limitations
- The web `pnpm typecheck` cannot be driven fully green in isolation right now because of the
  pre-existing `ExecutionContext` error in `apps/api/src/middleware/pipeline-bindings.ts` (a
  concurrent workstream's file, not T20's). Raised for orchestration; it does not touch T20's files.

## Confidence
High — the change mirrors two existing send-path builders verbatim over the same source value,
the state was already plumbed to the builder, and RED→GREEN is clean on the owned test file.
