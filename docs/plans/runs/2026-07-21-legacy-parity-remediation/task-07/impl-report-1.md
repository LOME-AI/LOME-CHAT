# T07 — R16: restore `webSearchEnabled` on regenerate — impl report 1

## Objective
Restore `webSearchEnabled` on the regenerate turn so a regenerated search-backed answer can stay a search answer. Parity anchor: `legacy/apps/api/src/legacy/routes/chat.ts:1027` (send path reads `webSearchEnabled` off the body; legacy regenerate threaded it too).

## Verification of the research premise (before implementing)
Confirmed the generic threading actually reaches the regenerate path:
- `turnDefinitionOrRefusal` (`routes.ts:556-616`) takes a structural `body` param already typed with `readonly webSearchEnabled?: boolean` (`:563`) and computes `const webSearchEnabled = body.webSearchEnabled === true` (`:602`), feeding both `buildTurnDefinition` and `buildMultiModelTurnDefinition`.
- The regenerate handler calls that same function: `const definition = await turnDefinitionOrRefusal(c, deps, body, { userId, budget })` (`:1038`).
So the only gap was the schema stripping the field before it reached `body`. NEEDS_CONTEXT trigger did NOT fire — this is schema-level, as the brief expected.

## Files changed
- `apps/api/src/slices/chat/routes.ts` — (1) added `webSearchEnabled: z.boolean().optional()` to `regenerateTurnBodySchema` (mirrors the send schema's field + comment); (2) removed the now-false omission comment at the regenerate handler and rewrote it to state the resolver threads the web-search flag identically; (3) added `...(body.webSearchEnabled === true ? { webSearchEnabled: true } : {})` to `regenerateTurnBodyHash`, matching the send path's dedup line (`startTurnBodyHash:714`).
- `apps/api/src/slices/chat/routes.integration.test.ts` — added the parity test.

## Tests added
- `threads web search onto the answer node for a tool-capable regenerate (201)` (behavior: a regenerate carrying `webSearchEnabled:true` on a tool-capable model produces a turn whose answer `modelCall` has `tools: ['webSearch']` and `maxSteps: 10`) — covers the acceptance criterion. Modeled exactly on the existing send-path test at `:872`, using `postRegenerate` + `withIsolatedCatalog` + `seedToolCapableModelId`.

## Self-gate
- `vitest routes.integration.test.ts -t "tool-capable regenerate"` — RED first (`expected [] to deeply equal [ 'webSearch' ]`, tools empty because the field was stripped → `webSearchEnabled=false`; res was 201, so RED on the assertion, not an error), then GREEN after the schema fix.
- `vitest apps/api/src/slices/chat/routes.integration.test.ts` (full file) — pass, 157/157.
- `vitest apps/api/src/slices/chat/routes.test.ts` (schema unit file) — pass, 23/23.
- `tsc --noEmit` (apps/api) — pass, exit 0.
- `eslint src/slices/chat/routes.ts src/slices/chat/routes.integration.test.ts` (from apps/api, after last edit) — pass, exit 0.

## Acceptance criteria
- `regenerateTurnBodySchema` gains `webSearchEnabled: z.boolean().optional()` — MET (`routes.ts`, regenerate schema).
- Flows through the already-generic `turnDefinitionOrRefusal` exactly as the send path does — MET (verified above; test proves the answer node carries `tools: ['webSearch']`, `maxSteps: 10`, identical to the send-path assertion).
- Omission comment (`:1034-1037`) removed — MET (`grep` for "never enables web search" / "carries no webSearchEnabled" returns nothing; comment rewritten to describe the identical resolver).
- Test shows a regenerate with the flag produces a search turn definition — MET (new integration test).

## Deviations with reasons
- **Added a hash line to `regenerateTurnBodyHash` beyond the literal "schema + comment" scope.** Reason: adding `webSearchEnabled` to the schema without hashing it would make it the only meaningful regenerate field the dedup hash ignores — a reused `Idempotency-Key` with a toggled `webSearchEnabled` would silently attach to the prior run instead of 409ing, unlike every sibling field and unlike the send path (`startTurnBodyHash:714` hashes it). This inconsistency is introduced by my schema addition, so cleaning it is in-scope per G7 ("clean up only your own mess"). The line is in `regenerateTurnBodyHash` (`~:738`), far from T08's user-only-message edits — no file-coordination conflict. Raised to the orchestrator.

## Concerns and limitations
- None. Web client already sends `webSearchEnabled` on regenerate? Not in scope for this task (files list is `chat/routes.ts` only); the server now honors the flag when present, matching the send contract. If the web regenerate composer needs to send it, that is a separate client change outside this task's ownership — not required by the acceptance criteria.

## Confidence
High — the fix is one schema field plus a matching hash line; the generic threading was verified in code and proven by a test that went RED for the exact missing-field reason then GREEN; full affected suites, typecheck, and lint all pass.
