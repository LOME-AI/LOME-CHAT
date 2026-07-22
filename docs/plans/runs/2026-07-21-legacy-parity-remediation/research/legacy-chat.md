# Legacy → New parity research: chat (R4, R6, R16, R18, R20)

All line numbers below were opened and read this session. Where the audit's cited
legacy line numbers (`docs/history/2026-07-21-legacy-parity-audit.md`) did not match
the current `legacy/` checkout, this is flagged explicitly in NOTES rather than
guessed at.

---

### R4 — user-only ("AI off") messages lost forkId support

**LEGACY** `legacy/apps/api/src/legacy/services/chat/message-helpers.ts:467-544`

```ts
export async function resolveParentMessageId(
  db: Database,
  conversationId: string,
  forkId?: string
): Promise<string | null> {
  if (forkId) {
    const [fork] = await db
      .select({ tipMessageId: conversationForks.tipMessageId })
      .from(conversationForks)
      .where(eq(conversationForks.id, forkId));
    return fork?.tipMessageId ?? null;
  }
  // ...linear tip fallback
}

export class ForkTipConflictError extends Error { /* code, forkId, expectedTipMessageId */ }

export async function updateForkTip(
  tx: DatabaseClient,
  forkId: string,
  newTipMessageId: string,
  expectedTipMessageId: string | null
): Promise<void> {
  // CAS UPDATE ... WHERE id = forkId AND tip_message_id IS NOT DISTINCT FROM expected
  // zero rows -> throw new ForkTipConflictError(...)
}
```

`legacy/apps/api/src/legacy/services/chat/message-persistence.ts:40-119` —
`saveUserOnlyMessage`'s params include an **optional** `forkId?: string`
(`SaveUserOnlyMessageParams`, line 47), and inside the transaction:

```ts
// line 106-111
if (forkId) {
  // parentMessageId IS the fork tip when forkId is set (resolved upstream
  // via resolveParentMessageId). Conditional update detects a concurrent
  // writer that beat us to advancing the tip.
  await updateForkTip(tx, forkId, messageId, parentMessageId);
}
```

The paid/streaming routes fully wire this: `legacy/apps/api/src/legacy/routes/chat.ts:873`
(`resolveParentMessageId(db, conversationId, forkId)` for the stream-chat send) and
`:980-1002` (regenerate: destructures `forkId` from the body, resolves
`forkTipMessageId`, threads it into `runRegenerateGates`/`dispatchModalityRequest`).
`legacy/apps/api/src/legacy/lib/stream-pipeline.ts:1740` shows the paid pipeline
conditionally spreading `forkId` into `saveChatTurn`:
`...(args.forkId !== undefined && { forkId: args.forkId })`.

**However**, the literal `POST /:conversationId/message` handler as currently
committed in this repo's `legacy/` snapshot (`legacy/apps/api/src/legacy/routes/chat.ts:895-963`)
does **not** wire `forkId` through:

```ts
// :902-921
const { messageId, content } = c.req.valid('json');   // no forkId destructured
...
const parentMessageId = await resolveParentMessageId(db, conversationId);  // 2-arg call
...
result = await saveUserOnlyMessage(db, {
  conversationId, userId: user.id, senderId: user.id, messageId, content, parentMessageId,
  // no forkId passed
});
```

No test in `message-persistence.test.ts`'s `describe('saveUserOnlyMessage', ...)`
block (`:1698-1960`) exercises `forkId` either — only the `saveChatTurn with forkId`
describe block (`:1383-1698`, for the **paid** turn) does.

**CURRENT**

- `packages/shared/src/schemas/api/conversations.ts:156-159` —
  `userOnlyMessageSchema = z.object({ messageId: z.uuid(), content: z.string().min(1) })`
  — no `forkId` field.
- `apps/api/src/slices/chat/domain/user-message.ts:52-58` — `SaveUserOnlyMessageArgs`
  has no `forkId`. Line 151: `const parentMessageId = await deps.stores.latestMessageIdWithinTx(tx, args.conversationId);`
  — unconditional linear-tip resolution, no fork awareness at all (no CAS, no
  `advanceForkTip` call site exists in this file).
- `apps/api/src/slices/chat/routes.ts:1266-1298` — route destructures only
  `{ messageId, content }` from `userOnlyMessageSchema`, no forkId.
- `apps/web/src/hooks/chat/use-authenticated-chat.ts:1131-1172` (`handleSendUserOnly`)
  — client sends only `{ messageId, content }` to `client.chat[':conversationId'].message.$post`
  (line 1147-1153); no `forkId` in the request. Yet the client-side optimistic
  parent (line 1139-1141: `allCurrentMessages = [...forkFilteredDecrypted, ...optimisticMessages]`,
  `lastMsg = allCurrentMessages.at(-1)`) parents the OPTIMISTIC message onto the
  last message of the **currently viewed fork**, while the server always parents
  onto the **global linear tip** — a mismatch that reproduces the audit's
  "message vanishes on refetch while viewing a non-Main fork" symptom.
- `apps/web/src/hooks/chat/use-fork-messages.ts:13-31` — `collectAncestorIds` walks
  tip→root strictly via `parentMessageId`; a message parented off-fork by the
  server is invisible to any fork whose ancestor walk doesn't pass through it.
- The **pattern to mirror** (paid turns) lives in
  `apps/api/src/slices/chat/domain/settlement.ts`:
  - `:142-152` — `ChatSettlementIdentity.forkId?: string | null` with docstring:
    "the turn chains onto the fork's tip (resolved under a fork-row lock) instead
    of the linear high-sequence tip, and advances that tip to the new assistant
    reply — both inside this settlement transaction."
  - `:257-263` — `lockedForkTip = identity.forkId == null ? null : await resolveForkTip(...)`.
  - `:548-553` — `if (identity.forkId != null && graft.advanceForkTip) { await advanceForkTip(conversationsStores, identity.conversationId, identity.forkId, { expectedTipMessageId: graft.forkExpectedTip, newTipMessageId: lastSiblingId }); }`
  - Underlying CAS primitives: `apps/api/src/slices/conversations/domain/fork-tip.ts`
    (`resolveForkTipWithinTx`, `advanceForkTipWithinTx` — see R6 below), published
    via the conversations slice barrel (`createConversationsStores`,
    `resolveForkTipWithinTx`, `advanceForkTipWithinTx` imported at
    `settlement.ts:10,18`).

**DELTA**: legacy's service layer (`saveUserOnlyMessage`) supported forkId
end-to-end (accept optional forkId → resolve tip if present → CAS-advance tip on
save), but the specific `/message` route in the checked-in legacy snapshot did not
wire it through either (untested, unused parameter). New code dropped the forkId
parameter from the schema, the domain args, and the persistence call entirely —
`saveUserOnlyMessage` in `user-message.ts` has no fork awareness at all, unlike
legacy's function which at least accepted (if unused-by-the-route) `forkId`. The
web client also never sends `forkId` for user-only sends despite already
maintaining a fork-filtered message list.

**NOTES**:
- The audit's cited legacy lines for this finding (L1704-1709, L1793, L1799) do not
  correspond to `legacy/apps/api/src/legacy/routes/chat.ts` (1157 lines total) as
  currently committed. L1793/L1799 DO line up with
  `legacy/apps/api/src/legacy/lib/stream-pipeline.ts` (`ImagePipelineInput.forkId?:
  string;` at :1792, and the `executeMediaPipeline` docstring at :1796-1801) — i.e.
  the audit's line numbers appear to trace through a different/bigger legacy file
  (or an earlier revision) than what git currently has checked into `legacy/`. The
  *behavioral* claim (service-layer forkId support existing) is independently
  verified above regardless of the exact original line numbers.
- To mirror the paid-turn pattern for user-only sends: add `forkId?: string` to
  `userOnlyMessageSchema`, thread it through `SaveUserOnlyMessageArgs` →
  `writeUserOnlyMessage`, and call `resolveForkTipWithinTx`/`advanceForkTipWithinTx`
  (already published by the conversations slice barrel, already imported into the
  chat slice for settlement.ts) exactly as settlement.ts does — no new primitive
  needed, only new wiring in `user-message.ts` + `routes.ts` + the web client's
  `handleSendUserOnly`.

---

### R6 — fork-tip / epoch-wrap settlement conflicts surface as INTERNAL 500 + Sentry

**LEGACY** — the dispatcher-equivalent is
`legacy/apps/api/src/legacy/lib/classify-stream-error.ts:83-102`
(`classifyStreamErrorCode`), which explicitly discriminates by error **name**:

```ts
// :83-87
export function classifyStreamErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return ERROR_CODE_STREAM_ERROR;
  if (error.message.includes('context length')) return ERROR_CODE_CONTEXT_LENGTH_EXCEEDED;
  if (error.name === 'ForkTipConflictError') return ERROR_CODE_FORK_TIP_CONFLICT;
  if (isUniqueViolation(error)) return ERROR_CODE_DUPLICATE_MESSAGE;
  // ...rate-limit / content-policy / provider-billing / network / AI-SDK buckets
  // last-resort: ERROR_CODE_STREAM_ERROR
}
```

module docstring (`:1-13`): "ForkTipConflict and unique-violation surface as their
own codes ... AI SDK errors with no other specific bucket fall to
ERROR_CODE_INFERENCE_FAILED; non-AI-SDK errors fall to ERROR_CODE_STREAM_ERROR."
The `/:conversationId/message` route itself also catches `ForkTipConflictError` by
`instanceof` directly: `legacy/apps/api/src/legacy/routes/chat.ts:923-926`
(`if (error instanceof ForkTipConflictError) return c.json(createErrorResponse(ERROR_CODE_FORK_TIP_CONFLICT), 409);`).
`ERROR_CODE_FORK_TIP_CONFLICT` is imported from `@hushbox/shared` in both files —
i.e. it was a shared, dedicated wire code, not folded into a generic conflict code.

**CURRENT** — three throw classes, defined together in
`apps/api/src/slices/chat/domain/settlement.ts:54-90`:

```ts
export class EpochWrapConflict extends Error { /* :56-65 docstring: superseded epoch or removed member */ }
export class ForkTipConflict extends Error { /* :67-78 docstring: fork gone OR tip moved under lock — "a concurrency defect" */ }
export class ForkTipMovedConflict extends Error { /* :80-90 docstring: regenerate guard's observed tip stale */ }
```

Throw sites (all in `settlement.ts`):
- `EpochWrapConflict` — `:334`, `:338-340`, `:347`, inside `resolveWrapKey` (`:321-356`).
  All three cover the epoch-at-persist gate: stale `currentEpoch`, sender no longer
  an active member, or the member-keyed epoch assertion failing. All are races
  inherent to ordinary group-chat concurrency (rotation, membership change mid-run).
- `ForkTipMovedConflict` — `:789`, inside `assertObservedForkTip` (`:780-793`): the
  fork-tip TOCTOU fence — a co-member spliced a message onto the tip via
  `PUT /forks/:id/tip` after the regenerate pre-run guard validated its deletable
  tail. Also an ordinary race, not a defect.
- `ForkTipConflict` — **two** throw sites with **opposite** defect classification
  in their own docstrings:
  - `:963-971` (`resolveForkTip`): "A fork absent at settlement — deleted while the
    run executed — throws to terminal-fail the run" → throws `ForkTipConflict` on
    `resolveForkTipWithinTx` returning `Err`. **Documented EXPECTED.**
  - `:980-993` (`advanceForkTip`): `/* v8 ignore next -- the fork-row lock the
    resolve step holds guarantees the CAS matches its own locked tip; a zero-row
    outcome is an unreachable concurrency defect, guarded defensively */` → throws
    `ForkTipConflict` on `advanceForkTipWithinTx` returning `Err`. **Documented
    GENUINE DEFECT** (unreachable under correct locking).

Underlying primitives, `apps/api/src/slices/conversations/domain/fork-tip.ts`:
- `:7-19` (module docstring) + `:31-44` (`resolveForkTipWithinTx`): fork absent →
  `notFoundError('chat fork tip: fork not found at settlement')`. Docstring: "A
  fork absent at settlement (deleted mid-run) is an expected `not_found`."
- `:55-61` (docstring on `advanceForkTipWithinTx`) + `:63-87`: "a zero-row outcome
  is a genuine concurrency defect (the fork moved or vanished despite the lock):
  re-read to disambiguate gone (`not_found`) from moved (`conflict`)." The function
  itself still returns a normal typed `DomainError` (`not_found` or `conflict`),
  not a throw — the "defect" framing is asserted only in the docstring/v8-ignore,
  not encoded in the error's own shape.
- `apps/api/src/slices/conversations/domain/wrap-epoch.ts:8-27` (module docstring),
  `:25-26`: "The boolean is an unused success token; every failure is an expected
  domain `Result` error, never a defect."

Engine catch site, `apps/api/src/slices/workflows/engine/interpreter.ts:1009-1039`
(`settle()`):

```ts
} catch (error) {
  if (error instanceof AllBranchesFailedError) return { kind: 'all-branches-failed' };
  if (error instanceof StorageUnavailableError) return { kind: 'storage-unavailable' };
  this.deps.telemetry.captureError(error, FINGERPRINT_CODES.workflowSettlementDefect);
  return { kind: 'defect' };
}
```

`apps/api/src/slices/workflows/engine/failures.ts:73-84` (`runFailureCode`):
`.with({ kind: 'defect' }, () => ERROR_CODES.INTERNAL)` — every `settlement.ts`
throw not named `AllBranchesFailedError`/`StorageUnavailableError` (i.e. all five
`EpochWrapConflict`/`ForkTipConflict`/`ForkTipMovedConflict` throw sites) lands here
as `INTERNAL` + a Sentry `workflowSettlementDefect` capture — including the four
sites that are self-documented as **expected**.

Existing wire codes (`packages/shared/src/error-codes.ts`):
- `:76` — `FORK_TIP_CONFLICT: 'FORK_TIP_CONFLICT'` — still exists, wired only for
  the `PUT /forks/:id/tip` CAS refusal path:
  `apps/api/src/slices/conversations/domain/outcomes.ts:120-127`
  (`.with({ refusal: 'fork-tip-conflict' }, (r) => ({ code: ERROR_CODES.FORK_TIP_CONFLICT, status: 409, details: { currentTipMessageId: r.currentTipMessageId } }))`).
  Friendly message at `packages/shared/src/error-messages.ts:200`:
  `'Someone else updated this branch. Refresh and try again.'` — **byte-identical
  in spirit to the legacy client mapping the audit cites** (already present, just
  unreachable from chat settlement).
- No `EPOCH_WRAP_CONFLICT`-style code exists anywhere in `error-codes.ts` (grepped
  the full file — zero `EPOCH_WRAP` hits). The generic `CONFLICT` code exists
  (`:22`, `:267`) with message `'This action conflicts with the current state.
  Please refresh and try again.'` (`:138`).
- The `DomainError` → wire-code mapping already has a taxonomy-generic path:
  `apps/api/src/lib/errors/domain-error.ts:60-62` (`domainWireCode`) resolves
  `error.wireCode ?? DOMAIN_ERROR_CODE_TO_WIRE_CODE[error.code]` — every
  `DomainErrorOf<C>` can carry an **explicit override** wire code (`:28-40`,
  `wireCode?: ErrorCode`), and `DOMAIN_ERROR_CODE_TO_WIRE_CODE`
  (`packages/shared/src/error-codes.ts:262-271`) already maps `not_found` →
  `NOT_FOUND`, `conflict` → `CONFLICT`, `forbidden` → `FORBIDDEN` generically.

**DELTA**: legacy classified `ForkTipConflictError` by name into its own wire code
at the stream-error dispatcher (and again at the route level for the non-streaming
path), alongside several other named/typed buckets, defaulting only truly
unclassified errors to a generic code. New code's engine-level `settle()` catch
inverts this: it allow-lists exactly two classes (`AllBranchesFailedError`,
`StorageUnavailableError`) and Sentry-defects everything else, including three
error classes whose own docstrings say they're expected outcomes of ordinary
concurrency, not defects — and even conflates one expected case
(`resolveForkTip`'s fork-absent) with one genuinely-unreachable case
(`advanceForkTip`'s CAS zero-row) inside the single `ForkTipConflict` class.

**NOTES (design-shape decisions)**:
1. **Class split needed**: `ForkTipConflict` currently wraps two throw sites with
   opposite defect status. A remediation must either (a) split it into two classes
   (e.g. `ForkTipGoneConflict` vs `ForkTipAdvanceDefect`) so the engine can route
   them differently, or (b) keep one class but carry a discriminant field (e.g.
   `readonly genuine: boolean`) the engine can branch on. Given `advanceForkTipWithinTx`
   already disambiguates `not_found` (fork gone — arguably ALSO expected, same as
   resolve) from `conflict` (tip moved — the truly-unreachable-under-lock case) at
   `fork-tip.ts:74-85`, the cleanest split may track the underlying `DomainError.code`
   rather than the call site: `not_found` → expected in both resolve and advance;
   `conflict` from advance → the one genuinely-unreachable-under-lock case.
2. **What must be discriminated in `settle()`**: to route expected conflicts to a
   `{code}` Result with no Sentry (mirroring `AllBranchesFailedError`/`StorageUnavailableError`'s
   existing pattern), `EpochWrapConflict`, `ForkTipMovedConflict`, and the
   expected half of `ForkTipConflict` need `instanceof` (or discriminant-field)
   checks added to `interpreter.ts`'s `settle()` catch, each mapped to a new
   `RunFailure` kind (mirroring `'all-branches-failed'`/`'storage-unavailable'`)
   that carries the underlying `DomainError` through `domainWireCode()` (already
   exists, unused here) rather than hardcoding `ERROR_CODES.INTERNAL`. The one
   remaining genuine-defect throw site (advance-tip CAS zero-row with `conflict`
   code) should keep failing to Sentry as `{ kind: 'defect' }`.
2b. Reusing the existing `FORK_TIP_CONFLICT` wire code (already has the exact
    legacy-parity message) for the fork-tip cases, and either a new
    `EPOCH_WRAP_CONFLICT` code or the generic `CONFLICT` code for the epoch-wrap
    cases, is a decision for the remediation author/founder — no such code exists
    today and the taxonomy's generic `conflict` → `CONFLICT` mapping already covers
    it without inventing one, at the cost of a less specific client message.
3. The audit's cited legacy line numbers (L4783-4794) do not match any single file
   found in this session's search of the `legacy/` corpus at that magnitude (the
   largest single chat-related legacy file, `stream-pipeline.ts`, is 2050 lines);
   `classify-stream-error.ts` (103 lines) is the behaviorally-equivalent dispatcher
   verified above and is the strongest direct analog, independent of exact line
   citation.

---

### R16 — regenerate never re-enables web search

**LEGACY** — not independently re-verified this session against the audit's exact
`legacy/apps/api/src/legacy/routes/chat.ts:1027` citation (file line 1027 in the
current checkout is inside the **stream-chat send** route: `webSearchEnabled:
requestBody.webSearchEnabled ?? false,` at `chat.ts:1027`, part of the
`dispatchModalityRequest` call at `:1015-1032` — this is the initial-send path, not
regenerate). This is consistent with the audit's underlying claim (send reads
`webSearchEnabled` off the body) but the specific route/line pairing for
"regenerate reads it too" was not independently re-confirmed in this session's
legacy read; treat the regenerate-side legacy behavior as the audit's own
verification, not re-derived here.

**CURRENT**

- `apps/api/src/slices/chat/routes.ts:100-105` (initial `/chat` send schema,
  `startTurnBodySchema`) —
  `webSearchEnabled: z.boolean().optional()` with comment: "Opt into server-side
  web search on the answer: the turn's modelCall carries the web-search tool loop.
  Requires a tool-capable model (refused at build otherwise). Absent/false is a
  plain turn."
- `apps/api/src/slices/chat/routes.ts:130-175` (`regenerateTurnBodySchema`) — **no
  `webSearchEnabled` field at all** (confirmed by full read of the schema object).
- `apps/api/src/slices/chat/routes.ts:1034-1037` — in-code comment directly
  acknowledging the omission:
  ```ts
  // The SAME resolver as the send paths — a regenerate resolves media
  // lists, the Smart Model sentinel, and multi-model fan-out
  // identically. The regenerate schema carries no `webSearchEnabled`,
  // so a re-run never enables web search.
  ```
- **How it flows on the initial turn**: `turnDefinitionOrRefusal`
  (`apps/api/src/slices/chat/routes.ts:556-616`) takes a structural `body` param
  typed with `readonly webSearchEnabled?: boolean | undefined` (`:563`) and at
  `:602-611`:
  ```ts
  const webSearchEnabled = body.webSearchEnabled === true;
  const definition = await (body.models === undefined
    ? buildTurnDefinition({ db: c.var.db, telemetry: c.var.logger }, body.model, { webSearchEnabled, budget: turn.budget })
    : buildMultiModelTurnDefinition({ db: c.var.db, telemetry: c.var.logger }, [...body.models], { webSearchEnabled, budget: turn.budget }));
  ```
  This same function is called for **both** the send route and the regenerate
  route (`:1038`: `const definition = await turnDefinitionOrRefusal(c, deps, body, { userId, budget });`
  inside the regenerate handler) — `turnDefinitionOrRefusal`'s structural param type
  already accepts `webSearchEnabled` generically; only `regenerateTurnBodySchema`
  itself is missing the field, so `body.webSearchEnabled` is always `undefined` for
  a regenerate request today, forcing `webSearchEnabled = false` at `:602`.
- `startTurnBodyHash` (`apps/api/src/slices/chat/routes.ts:705-724`) shows the
  dedup-hash convention already used for the send route's `webSearchEnabled`:
  `...(body.webSearchEnabled === true ? { webSearchEnabled: true } : {})` (`:714`)
  — an equivalent line would need adding to whatever hashes the regenerate body
  (`regenerateTurnBodyHash`, referenced at `:1051`, not read this session) to keep
  idempotency dedup consistent once the field is restored.
- `apps/api/src/slices/chat/domain/turn-definition.ts:60-62` —
  `buildTurnDefinition`'s options carry `webSearchEnabled: boolean` — the same
  builder the send path already uses; no new builder needed.

**DELTA**: the field exists on the send schema, is threaded generically through
`turnDefinitionOrRefusal` into the same turn-definition builder regenerate already
calls, and the omission is explicitly commented as deliberate-but-unruled in the
route file. Restoring it is schema-only (add `webSearchEnabled: z.boolean().optional()`
to `regenerateTurnBodySchema`) plus a matching dedup-hash field — no new plumbing.

---

### R18 — Smart Model chip lost on classifier failure

**LEGACY**

`legacy/apps/api/src/legacy/lib/pre-inference/smart-model-stage.ts:90-156`
(`runSmartModelStage`) — the classifier call is wrapped in a **blanket** try/catch:

```ts
// :115-131
let result: ClassifierStreamResult;
try {
  result = await consumeClassifierStream(aiClient, request);
} catch (error) {
  // Throw → no generationId, nothing to bill. Fall back to cheapest eligible.
  // Preserve the upstream cause for Sentry/dev logs so the failure isn't
  // silently swallowed; downstream still degrades gracefully.
  console.error('Smart Model classifier failed', error);
  return resolveOk({
    config, writer, assistantMessageId,
    resolvedId: fallbackId, billing: null, fallbackOccurred: true,
  });
}
```

Module docstring (`:35-38`): "Failure modes (classifier throws, no generationId,
garbage output) all fall back to the cheapest eligible model
(`classifierModelId`). The user still pays for the failed classifier attempt when
one was made; we degrade gracefully rather than aborting the slot." Crucially,
`resolveOk` returns `{ ok: true, ... }` regardless of `billing` being `null` — so
the stage is recorded as having **run successfully** even on a classifier throw.

`legacy/apps/api/src/legacy/lib/pre-inference/executor.ts:45-71`
(`executePreInferenceChain`) only pushes to `stagesRun` on a successful
(`outcome.ok`) stage result (`:60-64`): since `smart-model-stage.ts` converts a
classifier throw into an `ok: true` outcome, `stagesRun` still includes
`'smart-model'` even when the classifier itself failed.

`legacy/apps/api/src/legacy/lib/stream-pipeline.ts:1389-1400`
(`derivedIsSmartModel`):

```ts
/**
 * The `is_smart_model` flag must be tied to the routing stage specifically,
 * not "any stage that produces a `resolvedModelId`" ... Driven by the list of
 * stages that actually ran, NOT by billings: a classifier failure that falls
 * back to the cheapest eligible model produces no billing entry yet the
 * smart-model stage did run, so the chip still belongs on the response.
 */
export function derivedIsSmartModel(stagesRun: readonly string[]): boolean {
  return stagesRun.includes('smart-model');
}
```
Consumed at `:1442-1448` (`runPreInferenceForSlot`):
`isSmartModel: derivedIsSmartModel(chainResult.stagesRun)`.

**CURRENT**

- `apps/api/src/slices/workflows/nodes/smart-model-execution.ts:130-186`
  (classifier call): only `result.isErr()` (a typed `Result` failure surfaced by
  `streamModelCall`) degrades gracefully:
  ```ts
  // :159-161
  // Classifier failure is survivable by design: fall back to the cheapest
  // candidate with no charge (no generation happened).
  if (result.isErr()) return {};
  ```
  returns an empty `ClassifierOutcome` (no `charge`, no `resolvedId`) — the answer
  call still runs against the fallback/cheapest candidate, but there is no
  `stagesRun`-equivalent boolean threaded anywhere in this file; the "did the
  smart-model stage run" signal does not exist as a first-class value here —
  only the classifier `charge` (or its absence) is threaded onward. Pinned by
  `apps/api/src/slices/workflows/nodes/smart-model-execution.test.ts:375-395`
  ("falls back to the cheapest candidate on a classifier error, with no
  classifier charge" — asserts `success.auxiliaryCharges ?? []` is `[]`).
- `apps/api/src/slices/chat/domain/settlement.ts:464-492`
  (`aggregateDisplayCostByKey`) — the **only** current site computing the
  `isSmartModel` chip:
  ```ts
  // :475-491
  function aggregateDisplayCostByKey(charges, contentItemKeys) {
    for (const charge of charges) {
      ...
      const isClassifier = charge.key.endsWith(CLASSIFIER_CHARGE_KEY_SUFFIX);
      byKey.set(anchorKey, {
        costNanoUsd: ...,
        isSmartModel: (prior?.isSmartModel ?? false) || isClassifier,
      });
    }
  }
  ```
  Docstring at `:472-473`: "`isSmartModel` is true iff a classifier charge anchors
  here." — i.e. chip presence is derived purely from whether a **billed classifier
  charge** exists in `request.charges`, which is empty whenever `result.isErr()`
  short-circuited to `{}` in `smart-model-execution.ts:161` (no charge emitted).
  This is the charge-anchored (not stage-ran) signal the audit describes.
- **Secondary — unclassified thrown error fails the whole node**:
  `apps/api/src/slices/workflows/nodes/model-call-execution.ts:241-257`
  (`streamModelCall`'s inner loop, used by the classifier call too):
  ```ts
  try {
    for await (const event of deps.provider.infer(...)) { ... }
  } catch (error) {
    if (isAborted(error)) return settleAbortedPartial(deps, request, accumulator);
    if (isInferenceError(error)) return err(inferenceNodeError(error));
    throw error;   // :256 — anything else propagates
  }
  ```
  Only `isAborted`/`isInferenceError`-typed throws convert to a `Result` err (which
  `smart-model-execution.ts:161` then degrades gracefully). Anything else
  re-throws, propagating up to the node executor's try/catch in
  `apps/api/src/slices/workflows/engine/interpreter.ts:576-604`
  (`executeNode`), which special-cases only `DownloadByteCapExceeded` (`:584-589`)
  and `StorageUnavailableError` (`:594-599`) — everything else, including a
  genuinely-unclassified classifier throw, hits
  `this.deps.telemetry.captureError(error, FINGERPRINT_CODES.workflowNodeDefect)`
  (`:600-603`) and returns `FAILED_DEFECT` (`:604`), **failing the entire
  smartModel node** (both classifier and answer, since one node covers both
  stages) rather than degrading to the fallback candidate.

**DELTA**: legacy's classifier stage catches literally any thrown error at the
classifier-call boundary and always reports the stage as having run (`ok: true`,
`stagesRun` includes `'smart-model'`), decoupling the chip from billing entirely.
New code (a) computes the chip purely from the presence of a billed classifier
charge in settlement, so a gracefully-degraded (unbilled) classifier run never
badges the answer, and (b) only degrades gracefully for two typed throw shapes
(`isAborted`, `isInferenceError`) at the model-call layer — any other thrown error
(the "genuinely unclassified" case) fails the whole node as a Sentry defect,
whereas legacy's stage-level catch was unconditional (any `catch (error)`,
no type discrimination at all).

**NOTES (design-shape decisions)**:
1. **Where the stagesRun-equivalent signal must live**: there is currently no
   analog of legacy's `stagesRun: string[]` / `derivedIsSmartModel` anywhere in
   the new engine or chat domain — the chip is derived transitively from
   `SettlementCharge.key` suffix matching. Restoring legacy semantics ("chip =
   classifier stage ran, independent of billing") requires either (a) a new
   boolean signal threaded from `smart-model-execution.ts`'s classifier call
   through the node's success output into `SettlementRequest`/`SettlementCharge`
   so `aggregateDisplayCostByKey` can read "ran" instead of "billed", or (b) some
   other run-scoped carrier reaching settlement independent of the charges array.
   This is a schema-shape decision (what field carries the signal, and through how
   many typed boundaries — `ClassifierOutcome` → `NodeRunSuccess` →
   `SettlementCharge`/`SettlementRequest` → `aggregateDisplayCostByKey`) that the
   remediation author must choose.
2. **Where the graceful-degrade catch boundary moves**: to mirror legacy's
   unconditional catch, the fix must widen the classifier call's error handling —
   either catch broadly at `smart-model-execution.ts`'s classifier call site
   (currently only branches on `result.isErr()`, i.e. already-typed `Result`
   failures from `streamModelCall`) or change `model-call-execution.ts:250-256`'s
   `throw error;` fallthrough to also convert to a typed `Result` err reaching the
   classifier caller — the latter would change behavior for the **answer** call
   too (not just the classifier), which is a wider blast radius than legacy's
   stage-scoped catch. Scoping the wider catch to ONLY the classifier's
   `streamModelCall` invocation (not the answer call) is the closer legacy analog
   and the smaller-blast-radius option.
3. `smart-model-execution.test.ts:375-395` already pins "no charge on classifier
   error" as a correctness expectation for the *no-charge* half of the behavior —
   any remediation must keep that assertion true while adding the
   independent-of-billing chip signal, i.e. the fix is additive (a new field), not
   a change to the existing no-charge test.

---

### R20 — 23505 walk (chat copy only)

**CURRENT** `apps/api/src/slices/chat/domain/user-message.ts:77-88`:

```ts
/** Postgres unique-violation (SQLSTATE 23505), chain-walked. Any unique hit on
 * this write path — the messages PK or the (conversation, sequence) backstop —
 * means the send already exists in some form: converge, never re-insert. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === '23505') return true;
    current = candidate.cause;
  }
  return false;
}
```

No depth cap on the `cause` walk, and no constraint-name matching — any 23505
anywhere in the cause chain is treated as "already exists," regardless of which
unique index fired. Per the audit (R19, `:269-288`), this is one of four
independently-drifted copies of what was a single shared legacy helper
(`conversations/adapters/stores.ts:38-51`, `identity/adapters/stores.ts:46-56`,
this file, `admin/adapters/stores.ts:10-25`); consolidation is out of scope for
this file alone — recorded here as the chat-slice instance only, per task scope.
