# E2E Failure Research — chat-misc cluster

Run: `e2e/report/2026-07-20T05-25-42/` (`pnpm e2e:fast`, project **iphone-15**).
Run-wide: 206 total, 131 passed, **75 failed, 0 flaky** (no retry recovered — these are
deterministic in this run, not host-saturation flake; `resource-timeline.json` shows
load1 15–28 but every failure below is a hard API/DOM outcome, not a timeout-only).

Scope: 16 failures across smart-model (4), multi-model (3), regeneration (2),
multi-model-regeneration (1), fork-regeneration (1), chat (1), chat-scroll (1),
message-queue (1), document-panel (1), contracts/signals (1).

They collapse into **9 root causes**. Two are shared with the billing/other clusters.

---

## RC-1 — Regenerate route has no `SMART_MODEL_ID` branch (APP / apps/api)

**Tests:** fork-regeneration `regenerate-on-fork-only-affects-that-fork`;
smart-model `regenerate-re-runs-classification`; regeneration `retry-own-message-works…`
(group). All three: `POST /chat/regenerate` → **400 `{"code":"VALIDATION"}`** (some twice → retried).

**Evidence.** Captured regenerate request body (trace resource
`…/failed/e2e-chat-fork-regeneration…/trace/resources/84563dc0….json`):
```json
{"conversationId":"862fc4ab…","model":"smart-model","modality":"text",
 "targetMessageId":"68df2a65…","action":"retry","forkId":"019f7df9…",
 "userMessage":{"id":"fd0aa8f8…","content":"Followup …"},"history":[…]}
```
Body is schema-valid against `regenerateTurnBodySchema` (routes.ts:130). The 400 is a
**domain** VALIDATION, not zValidator. `apps/api/src/slices/chat/routes.ts:753-755`:
```ts
const definition = await (body.models === undefined
  ? buildTurnDefinition(deps, body.model, { budget })   // body.model === "smart-model"
  : buildMultiModelTurnDefinition(deps, [...body.models], { budget }));
```
`buildTurnDefinition` resolves `"smart-model"` (SMART_MODEL_ID, constants.ts:19) against
the exposed catalog; the sentinel is virtual → not in catalog → VALIDATION. The **send**
path has the missing branch — `turnDefinitionOrRefusal` routes.ts:586-596
(`if (body.model === SMART_MODEL_ID) buildSmartModelTurnDefinition(...)`), and the two
send handlers even guard it (routes.ts:854, 940). The regenerate path
(`regenerateTurnDefinitionOrRefusal`, routes.ts:734) was never given the symmetric branch.
Default model is Smart Model (`apps/web/src/stores/model.ts:21` `DEFAULT_MODEL_ID =
SMART_MODEL_ID`), so any regenerate of a default-model turn sends `model:"smart-model"`.
Solo regeneration tests that seed a *concrete* model pass; every Smart-Model / default
regenerate 400s.

**Determinism pillar:** Pillar 1 Proof (regenerate must run the real prod Smart-Model
turn, not a fail-closed reject). Also a symmetry defect: two builders diverged.

**Long-term fix:** route regenerate through the *same* turn-definition dispatcher as send
so the SMART_MODEL_ID branch is single-sourced (extract the send's
`turnDefinitionOrRefusal` model-selection head and call it from
`regenerateTurnDefinitionOrRefusal`). Do not special-case in the client.

**Enforcement rung (kills the class):** Rung 3 contract/integration test — parametrized
over every turn entrypoint (`/chat`, `/chat/regenerate`, guest, trial) asserting a
`model:SMART_MODEL_ID` body builds a smartModel turn (not VALIDATION). Ideally Rung 1: one
shared `resolveTurnModel()` both routes must call so an omitted branch fails typecheck.

---

## RC-2 — Pre-inference stage counter is never incremented; `markStageSeen` is dead (APP / apps/web)

**Tests:** smart-model `smart-model-send-runs-its-pre-inference-classifier-stage`
(`toBeGreaterThan(0)` on the baseline→advance poll, `Received: 0`, 15s timeout);
contracts/signals `pre-inference-signal-renders-and-advances-on-a-smart-model-turn`
(identical `Received: 0`).

**Evidence.** `data-pre-inference-stages-seen="0"` in every message-list snapshot
(e.g. multi-model follow-up error DOM). The counter comes from
`apps/web/src/stores/pre-inference-activity.ts` (`markStageSeen` → +1), surfaced at
`apps/web/src/components/chat/message/message-list.tsx:512`. **`markStageSeen` has zero
non-test callers** — `grep -rn markStageSeen apps/web/src` returns only the store
definition and the store's own unit test. Nothing in the stream/optimistic pipeline ever
calls it. The Smart-Model overhaul replaced the wire `stage:done` event with a
`stream-start` resolved-model label (use-chat-stream.ts:157-160,
use-authenticated-chat.ts:469-497) and, in the port, dropped the store increment. Note the
happy-path Smart chip still lights (`handleStreamModelResolved` sets `isSmartModel`), so
chip-asserting Smart tests pass while the *counter* tests fail — proving the two signals
were split and only one got rewired.

**Determinism pillar:** Pillar 2.2 — "wait only on app-emitted readiness signals; signals
are typed and contract-tested." The signal is emitted by the app's data attribute but its
producer is dead code; the contract test (rung 3) correctly caught it.

**Long-term fix:** call `markStageSeen()` where the pre-inference classifier stage is
observed — the natural site is the Smart-tile `onModelResolved` handler
(use-authenticated-chat.ts:485) and/or wherever `classifyingStageId` is set — so a Smart
turn advances the counter exactly once per stage.

**Enforcement rung:** the existing `test:contracts/signals` (rung 3) is the class-killer
and already fired; add a Rung 1/2 guard that the signal-registry action has a live
producer (dead-store lint / a type binding that fails build if `markStageSeen` is unused).

---

## RC-3 — Smart-Model fallback path emits no resolved-model label → no chip/nametag (APP / apps/api engine)

**Test:** smart-model `classifier-failure-falls-back-to-a-value-model-and-still-renders-a-response`
— `smart-model-chip` not found (10s).

**Evidence.** Header `x-mock-classifier-failure: true` makes the mock classifier throw
(`mock-provider.ts:325-326`, survivable → fallback). Page snapshot shows the answer *did*
render (`"Echo: Smart fallback …"`) but the nametag reads the placeholder **"Model"** and
there is **no Smart chip**. The chip requires `primaryMessage.isSmartModel`
(message-item.tsx:629), set only by `handleStreamModelResolved` when `onModelResolved`
fires for a tile in `smartTileIdsRef` (use-authenticated-chat.ts:485-497). On the
classifier-failure→fallback branch the composite smartModel turn produces an answer but
never emits the `stream-start` resolved-model label, so the client never marks the tile
Smart nor resolves its nametag. Happy-path Smart tests get the label and pass; only the
fallback branch is unlabeled.

**Determinism pillar:** Pillar 1 Proof — the fallback is real prod behavior and must be
observable identically to the happy path.

**Long-term fix:** the smartModel node must emit the resolved-model `stream-start` label
on the fallback path too (the fallback still *resolves* a concrete answering model —
`config.classifierModelId` / cheapest candidate). Then chip + nametag are branch-invariant.

**Enforcement rung:** Rung 3 — extend the smart-model contract/integration test matrix
with a classifier-failure case asserting a resolved-model label is emitted and the chip
renders.

---

## RC-4 — Client budget preflight can't price `SMART_MODEL_ID` → no insufficient-balance surface (APP / apps/web)

**Test:** smart-model `insufficient-balance-blocks-send-and-surfaces-the-budget-error`
(`lowBalancePage`) — `getByText(/Your free daily usage can't cover this message/i)` not visible.

**Evidence.** The string exists (`packages/shared/src/budget.ts:241,243`). Snapshot shows
only the typed prompt and a usage meter — no budget-messages block. The Smart Model is a
virtual id with no catalog price: `apps/web/src/hooks/models/models.ts:66` filters
`SMART_MODEL_ID` out, and `getModelCostPer1k(SMART_MODEL_ID)` is undefined, so the
client budget calc (`use-prompt-budget.ts` / `budget-messages.tsx`) cannot compute an
unaffordable state → produces no notification and does not disable send. The server-side
Smart affordability preflight exists (buildSmartModelTurnDefinition → 402), but the *client*
preflight the test asserts on never triggers for the sentinel.

**Determinism pillar:** Pillar 1.5 (assert the side effect/UX of the affordability gate)
and Pillar 3 (a real assertion that mirrors prod). Not a wall-clock/flake issue.

**Long-term fix:** give the client budget calc a Smart-Model pricing basis (the same
worst-case candidate ceiling the server reserves, or a dedicated preflight query) so the
insufficient-balance message and disabled send render for `SMART_MODEL_ID`.

**Enforcement rung:** Rung 3 — component/contract test that a Smart-Model selection on a
sub-threshold wallet yields the budget message + disabled send.

**INTENT note:** if product intends Smart Model to *defer* affordability entirely to the
server 402 (no client preflight), the test is asserting a client behavior the app
deliberately dropped — flag for ruling. Current code supports neither cleanly.

---

## RC-5 — INTENT CONFLICT: single-model regenerate wire shape (`model` vs `models[1]`) (TEST vs APP contract)

**Tests:** regeneration `retry-on-a-failed-multi-model-tile…` (`expect(body.models).toEqual(
[failModelId])` → `Received: undefined`); multi-model-regeneration
`regenerate-one-replaces-just-the-clicked-tile…` (`expect(body.models?.length).toBe(1)`
→ `Received: undefined`).

**Evidence.** For a per-tile regenerate (`replaceAssistantId` set),
`resolveRegenerateModels` returns a **single-element** array
(chat-regeneration.ts:208-209). The stream client only serializes `models` when length ≥ 2
and otherwise sends the singular `model`:
`use-chat-stream.ts:601-609` → `model: primary, …(request.models.length >= 2 ? {models} : {})`.
The server schema **forbids** a 1-element `models`: `regenerateTurnBodySchema.models =
z.array(...).min(2).optional()` (routes.ts:142). So `body.models` is *correctly* absent for
a single-model regenerate; the tile-targeting rides on `model` + `replaceAssistantId`.
The two tests assert the field the wire contract deliberately omits.

**Determinism pillar:** Pillar 3.3/1 — tests assert the wire contract; here test and
implemented contract disagree. No pillar is "violated" by the app; this is a spec conflict.

**Resolution options (do not pick a side):** (a) tests assert `body.model === failModelId`
(and `body.replaceAssistantId`) — matches the implemented min(2) contract; or (b) the
contract carries `models:[id]` for regenerate-one and the schema drops the min(2) floor on
the regenerate route. Functionally the app already targets the right model via `model`;
this is an assertion-vs-contract mismatch, likely stale tests from before the
`replaceAssistantId` design. **Flag for ruling.**

**Enforcement rung:** Rung 3 — one shared regenerate-wire contract fixture both the client
serializer and the server schema import, so the field set can't drift from the tests.

---

## RC-6 — INSUFFICIENT_ADMISSION on higher-cost Smart/multi-model sends (APP billing + isolation) — SHARED with billing cluster

**Tests:** multi-model `follow-up-message-includes…` (want assistant-count 4, got 3),
`wallet-debit-excludes-the-failed-model-on-partial-failure`,
`wallet-debit-matches-…-web-search…N-2`; chat-scroll
`user-message-and-ai-response-are-visible-after-sending`. All: `POST /chat` → **402
`{"code":"INSUFFICIENT_ADMISSION"}`** (5 dirs run-wide incl. group-chat-billing).

**Evidence & mechanism.** The billing research (`research/billing.md:21-25`) already pinned
the mechanism: **admission reserves the Smart Model's full-context worst-case ceiling**
(estimate-run.ts:295-306,356-386; runtime.ts:472-484; admitRun in
`chat/domain/runtime.ts:557-599`), "orders of magnitude" above small budgets. Default
model = Smart Model, so a default follow-up (chat-scroll) reserves that worst-case ceiling;
multi-model reserves it **per model** (N× fan-out); web-search adds per-model search cost;
a follow-up on an existing thread grows the history/context feeding the worst-case size.
The cheap fresh `wallet-debit-equals-sum-N=2` (no web search, short thread) **passes**;
every heavier variant 402s — consistent with an inflated worst-case reserve, not a seed
shortfall (test-alice = $100, `scripts/lib/seed-personas.ts` DEFAULT_TEST_BALANCE).
Secondary determinism concern: `authenticatedPage` = one shared `test-alice-<project>`
account across many serial/parallel chat specs; outstanding admission holds and the
best-effort/​swallowed Redis snapshot refresh (`runtime.ts:612` `withPostCommitSnapshotRefresh`,
failure is intentionally swallowed) mean available balance = balance − outstanding holds
can dip below the worst-case reserve deterministically under fixed order.

**Determinism pillar:** Pillar 2.6 (total isolation — shared wallet across specs) and
Pillar 1.3/1.5 (mock cost derived from real catalog; assert the money side effect). The
inflated-reserve half is a billing-doctrine question, not a test defect.

**Long-term fix (billing-sensitive — coordinate with billing cluster, do not skip/loosen):**
(a) admission for the Smart/default turn reserves a *bounded* per-turn ceiling instead of
full-context worst case, or the default pins a bounded model whose ceiling fits; AND
(b) per-test wallet isolation (or a fixture precondition that asserts available balance ≥
the turn's reserve before send) to remove shared-account hold bleed. Ruling pending in
billing.md — same root cause.

**Enforcement rung:** Rung 3 contract test "default/Smart turn worst-case admission reserve
≤ funded test balance" (mirrors billing.md's proposed "free-tier ceiling ≤ allowance"),
plus a Rung 4 fixture that fails a chat spec if it inherits nonzero outstanding holds.

---

## RC-7 — chat delete: stale unexpected-error opt-out patterns (TEST allowlist vs APP error surface)

**Test:** chat `can-delete-conversation-via-dropdown-menu` — "Unexpected errors during
test … API: 404 Not Found GET …/messages? body {"code":"NOT_FOUND"}".

**Evidence.** The test deliberately opts out (chat.spec.ts:103-109):
```
expectApiErrors(page, [/404 Not Found GET .*\/conversations\/[0-9a-f-]+(?=\?|\s|$)/,
                       /"code":"CONVERSATION_NOT_FOUND"/])
```
Actual post-delete errors (api-errors.txt): `GET /conversations/{id}` **and**
`GET /conversations/{id}/messages?`, body **`{"code":"NOT_FOUND"}`**. Two mismatches:
(1) the id-anchored regex uses lookahead `(?=\?|\s|$)` but the messages request has `/messages`
after the id, so that 404 is never matched; (2) the body is `NOT_FOUND`, the opt-out expects
`CONVERSATION_NOT_FOUND`. The auto-fail fixture guard (Rung 4) fired correctly.

**Determinism pillar:** the guard is Pillar 3/rung-4 working as designed; the defect is a
drifted allowlist OR an app change.

**INTENT / resolution:** decide whether the app *should* fire a second `/messages` prefetch
against a just-deleted id (a stale-query bug worth removing — the query should be
`removeQueries`'d on delete, not refetched) and whether the wire code is intended as
`NOT_FOUND` vs `CONVERSATION_NOT_FOUND`. If both are intended, update the two opt-out
patterns (`/messages` variant + `NOT_FOUND`). Prefer removing the stale prefetch (fewer
"expected error" opt-outs = stronger proof). **Flag the error-code + prefetch as ruling.**

**Enforcement rung:** Rung 2 — a typed error-code enum shared by app + test so the opt-out
regex can't reference a code (`CONVERSATION_NOT_FOUND`) the server no longer emits.

---

## RC-8 — Document extraction broken by the mock echo prefix (MOCK fidelity)

**Test:** document-panel `code-document-extraction-panel-copy-download-and-close` —
`document-card` at item-index 3 never appears (60s).

**Evidence.** The mock echoes `content = \`${MOCK_ECHO_PREFIX} ${prompt}\`` — a **space**,
not a newline (`mock-provider.ts:380-382`, `MOCK_ECHO_PREFIX = 'Echo:'`). The prompt is a
15-line fenced Python block whose first line is ```` ```python ````. Prepending `"Echo: "`
puts the opening fence mid-line (`Echo: ```python`), which is **not** a valid CommonMark
fence opener (fences must start the line). Markdown therefore fails to parse the 15-line
fenced block; the aria snapshot shows a mangled `paragraph: "Echo: ```python def
fibonacci(n): …"` plus a stray `code`/`Copy Code`, not a clean block. Extraction is
gated on a real fenced block of ≥ `MIN_LINES_FOR_DOCUMENT` (=15) via
`shouldExtractAsDocument` (`apps/web/src/lib/document-parser.ts:71-74`, called from
markdown-renderer.tsx:101) — with the fence destroyed, `lineCount` never reaches 15, no
`document-card`.

**Determinism pillar:** Pillar 1.1/1.3 — the mock is the only mocked edge and must not
corrupt the *shape* prod would produce; here it mangles multi-line assistant content.

**Long-term fix:** echo so a leading code fence stays at column 0 — e.g. newline-separate
the prefix (`Echo:\n${prompt}`) or drop the same-line prefix when the prompt begins with a
fence. Then a 15-line block round-trips and extracts, matching prod.

**Enforcement rung:** Rung 3 — a mock-fidelity contract test: feed the mock a fenced ≥15-line
block and assert the echoed content still parses as one fenced block of the same line count.

---

## RC-9 — message-queue: queued region never drains after held run releases (APP queue-drain / hold-release seam)

**Test:** message-queue `queued-message-auto-sends-after-active-run-completes` —
`expect(queued-messages).not.toBeVisible()` fails (30s); pill stack stays mounted.

**Evidence.** The spec uses the hold-stream knob that now exists
(`holdPrimaryStreamForNextSends`, `releaseHeldStream(testConversation.id)`,
mock-provider.ts:169,239,278 `holdPrimaryStream`/`awaitStreamRelease`). Flow: send A held,
queue B+C, cancel C, `stopHoldingStreams()` + `releaseHeldStream()`, expect B to auto-drain
at A's settle. No api-errors recorded — B never errored; it simply never sent, so the
`queued-messages` region never unmounts. The queue drains on A's **settle** signal; the
failure means either A's held run doesn't emit settle on release (so the drain trigger
never fires) or the drain-on-settle wiring is broken. Default model here is Smart Model,
so the hold interacts with the classifier stage — a plausible contributor (the held
"primary" stream may not be the tile the release barrier targets).

**Determinism pillar:** Pillar 2.2 — the queue-drain must gate on a real settle signal; if
release doesn't produce that signal the feature/harness seam is non-deterministic. The
project note ("message-queue e2e may need a hold-stream knob") is satisfied by the knob's
existence, but the release→settle→drain chain is incomplete.

**Long-term fix:** ensure `releaseHeldStream` drives the held run to a real terminal/settle
event that the queue's drain observes, and that the queue drains on the primary run's
settle regardless of Smart-vs-concrete model. Needs a live repro to confirm which link
(release barrier vs drain trigger) is dropped — recommend re-running this spec in isolation
with the hold knob and tracing the settle signal.

**Enforcement rung:** Rung 3/4 — contract test for the queue: hold a run, enqueue, release,
assert exactly one settle event and the queue drains to empty; fixture-level assert that a
released hold produces a terminal stream event.

---

## Cross-cluster / shared

- **RC-6** is the same admission-reserve mechanism `research/billing.md` documents
  (member-budget-exhausted free-tier). Any ruling there fixes both. Do not fix in isolation.
- **RC-1, RC-2, RC-3, RC-4** all trace to the **Smart-Model / model-catalog overhaul**
  leaving the *send* path complete but the *regenerate*, *pre-inference-signal*,
  *fallback-label*, and *client-affordability* paths un-rewired. A single "every turn
  entrypoint builds SMART_MODEL_ID and emits the same signals" contract matrix (Rung 3)
  would have caught RC-1/RC-2/RC-3 together.
- **RC-5** and **RC-7** are INTENT CONFLICTs (test assertion vs implemented contract) — need
  a human ruling, not a code fix chosen unilaterally.
- **RC-8** is the only pure mock defect; **RC-9** needs a live repro to localize.
