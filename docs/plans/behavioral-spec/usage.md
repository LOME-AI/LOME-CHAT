# Spec family: usage

**v2 owner:** `billing` slice (usage-analytics read endpoints over `usage_records`).

## e2e behaviors — `e2e/usage/usage.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| The usage page renders charts and its filters work | `usage page renders charts and filters work` | billing (read) |

## Integration behaviors — `apps/api/src/routes/usage.test.ts`

Usage read-endpoint contract (aggregation, filters, auth). Titles not captured this
session — read the file at port time; it is the authoritative source for the endpoint
shapes the chart UI consumes.

## Persisted-shape facts the family depends on (code Verified)

- Per-message cost and token counts persist on the assistant message (`cost`, `inputTokens`, `outputTokens`, `isEstimated`) — `apps/api/src/lib/stream-pipeline.ts:1149-1160` (`AssistantPersistInput`).
- Smart Model sends persist per-stage usage rows in addition to the main one — `apps/api/src/lib/stream-pipeline.ts:1216-1224` (see `smart-model.md`).
- v2 reshapes storage into `usage_records` with `runId` grouping and nullable content FK (`SET NULL` on deletion, billed ⟹ persisted invariant) — ARCHITECTURE.md data-model essentials. The read-endpoint behaviors above are what must survive that reshape.

## Cost-display contract (cross-family, Verified via e2e titles)

- Per-model cost badges render on responses (`e2e/chat/multi-model.spec.ts` :: `displays cost per model response`; `e2e/chat/image-generation.spec.ts` :: `generated image displays cost badge and model nametag`).
- Wallet debits must equal the sum of displayed costs (`multi-model.spec.ts` :: `wallet debit equals the sum of per-model displayed costs for N=2`).
- v2's estimate→true-up flow shows cost only once final (`cost: pending` → `cost-final`, `~`-marked estimate on timeout) — ARCHITECTURE.md; the displayed-cost == debited-cost invariant above is the behavior to preserve.
