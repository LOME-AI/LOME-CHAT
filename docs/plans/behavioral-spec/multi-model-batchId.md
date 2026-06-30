# Spec family: multi-model / batchId

**v2 owner:** `chat` slice. The multi-model turn becomes a data-driven `fanOut` workflow
(BACKEND-REDESIGN §11); sibling identity rides on `batchId`.

## The batchId contract (code Verified)

`packages/db/src/schema/messages.ts:22-35`: `batchId` is a per-turn identifier shared by
every message persisted in a single `saveChatTurn`. Two assistant messages with the same
parent are **multi-model peers iff their `batchId`s match**. The fork-filter uses this to
distinguish parallel fan-out (siblings always travel with their shared parent) from
fork-preserved orphans (a retry upstream of a fork branch keeps the prior assistant alive
because fork descendants still point at it). Default is a fresh uuid so legacy rows are
each their own batch. Exposed on the wire at
`packages/shared/src/schemas/api/conversations.ts:256` (`messageResponseSchema.batchId`).
Fan-out width cap: `MAX_SELECTED_MODELS = 5` (`packages/shared/src/constants.ts:257`).

## e2e behaviors

### `e2e/chat/multi-model.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Multiple models selectable via modal toggle; removable from comparison bar; max limit enforced; modal reopens with current selections; clear-all works | `selects multiple models via toggle in modal`, `removes model from comparison bar`, `enforces max model limit`, `modal opens with current selections checked`, `clear selected removes all selections` | chat (web) + models |
| Selection and picker mode (single/multi) persist across reload | `persists selection across page reload`, `picker mode (single/multi) persists across page reload` | web |
| Single mode commits + closes on row click; multi mode Cancel discards local changes | `single mode: clicking a row commits + closes the modal immediately`, `multi mode: Cancel discards local changes (does not commit)` | web |
| A send fans out to all selected models and streams parallel responses | `sends to multiple models and receives parallel responses` | chat |
| Each response shows its model nametag and per-model cost | `each AI response shows model nametag`, `displays cost per model response` | chat |
| A follow-up message includes **all** previous sibling responses in history | `follow-up message includes all previous responses in history` | chat |
| Wallet debit equals the **sum** of per-model displayed costs (N=2), including when web search runs | `wallet debit equals the sum of per-model displayed costs for N=2`, `wallet debit matches displayed cost when web search runs with N=2 models` | billing |
| Multi-model responses persist on a fork after streaming completes | `Multi-Model on Fork » multi-model responses persist on fork after streaming completes` | chat |
| Single-model selection is unchanged by the multi-model machinery (regression guard) | `Single-Model Regression » single model selection works identically to before` | chat |
| Partial model failure: the failed slot shows an error while siblings succeed; the wallet debit **excludes** the failed model | `Partial Failure » handles partial model failure gracefully`, `wallet debit excludes the failed model on partial failure` (driven by `x-mock-failing-models`) | chat + billing |

### `e2e/chat/multi-model-media.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Two image models render distinct images with distinct nametags | `two image models render distinct images and nametags` | chat + media |
| Failing image model shows an error tile while the successful sibling renders | `failing image model shows error tile while successful one renders` | chat + media |
| Fork from a multi-model image branch keeps both siblings on the source branch | `fork from multi-model image branch keeps both siblings on the source branch` | chat (batchId) |
| Two video models render distinct videos race-free | `two video models render distinct videos race-free` | chat + media |
| Failing video model shows an error tile while the successful one renders | `failing video model shows error tile while successful one renders` | chat + media |
| Multi-model image responses survive a page reload (persisted siblings) | `multi-model image responses survive a page reload` | chat + media |

### `e2e/chat/multi-model-regeneration.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Retry-all replaces **every** sibling and charges the sum of all new costs | `retry-all replaces every sibling and charges the sum of all new costs` | chat + billing |
| Regenerate-one replaces only the clicked tile and preserves siblings | `regenerate-one replaces just the clicked tile and preserves siblings` | chat |

## Integration behaviors

| Behavior area | Source | v2 slice |
| --- | --- | --- |
| Slot fan-out, per-slot persist inputs, failed-slot exclusion from billing | `apps/api/src/lib/stream-pipeline.test.ts` | chat |
| Per-slot SSE multiplexing (streamId-style event routing) | `apps/api/src/lib/multi-stream.test.ts` | chat |
| `batchId` on the message wire schema | `packages/shared/src/schemas/api/conversations.ts:256` | chat |

v2 note: per-stream cursors/`streamId` replay in the DO (§10) must reproduce the
"parallel responses, partial failure isolated, debit = sum of successful slots"
observable behavior encoded above.
