# Group billing — verified facts

Distilled from a five-agent parallel investigation on 2026-07-23 (direct file reads;
citations gathered and cross-checked that session). FACTS ONLY — no recommendations.
Context: `docs/plans/runs/2026-07-23-affordability-remediation/research/current-system.md`
and `docs/BILLING.md`. Line numbers are as of this session's working tree and may drift.

**Naming correction vs docs/BILLING.md**: the doc's prose refers to a function
`resolveBilling` in `packages/shared/src/resolve-billing.ts`. No such function/path exists
in the current tree. The actual core is `resolveFundingDecision` in
`packages/shared/src/billing/funding-decision.ts`; the client wrapper is
`resolveClientBilling` in `packages/shared/src/billing/client-billing.ts`.

---

## 1. Funding decision — exact priority logic

`packages/shared/src/billing/funding-decision.ts` — `FundingInputs` (26-41): `isSolo`,
`isGuest`, `memberRemainingNanoUsd`, `conversationRemainingNanoUsd`,
`ownerPurchasedBalanceNanoUsd`, `callerOwnPurchasedBalanceNanoUsd`, `isPremiumModel`.

`resolveFundingDecision` (113-128):

```ts
if (!inputs.isSolo) {
  const effective = groupHeadroom(memberRemainingNanoUsd, conversationRemainingNanoUsd, ownerPurchasedBalanceNanoUsd)
  if (effective > 0n) return { payer: 'owner', walletKind: 'purchased', premiumAllowed: true }
  if (inputs.isGuest) return { payer: 'refuse', refusalCode: 'GROUP_BUDGET_EXHAUSTED' }
}
return selfFunding(callerOwnPurchasedBalanceNanoUsd, isPremiumModel)
```

- `groupHeadroom` (74-85): `min(clamp≥0(memberRemaining), clamp≥0(conversationRemaining), clamp≥0(ownerPurchasedBalance))` — each of the three dimensions independently clamped to ≥0 before the min, so a negative/absent dimension reads as 0 rather than masking a smaller sibling.
- **"Owner can use the model" is NOT a premium-tier check on the owner.** When `effective > 0n` the decision is unconditionally `{ payer: 'owner', premiumAllowed: true }` (121) — "premium-exempt by construction" (docstring 43-47, 58). The only sense in which "owner can use the model" gates anything is that the owner's *purchased balance* is one of the three min-dimensions of `groupHeadroom` — a balance check, not a tier/premium check.
- `selfFunding` (92-105): `canAccessPremium = callerOwnPurchasedBalanceNanoUsd > 0n`; premium model + no access ⇒ refuse `MODEL_TIER_LOCKED`; else `payer:'self'`, wallet `'purchased'` if `canAccessPremium` else `'free'`. This premium check runs **only** for self-funders, never for owner-funded turns.
- Exhaustion behavior differs by sender kind: a signed-in member falls through to `selfFunding` (127); a link guest is refused outright (123-125) — there is no wallet to fall through to.

**Server call sites** (never call `resolveClientBilling`, which is client-only):
- `resolvePayerWallet` (`apps/api/src/slices/chat/domain/turn-context.ts:349-438`), calls at `:395`.
- `tierGateRejection` (`apps/api/src/slices/chat/routes.ts:514-536`), calls at `:525` and `:531`; skips the premium re-check entirely when `baseline.payer !== 'self' || baseline.premiumAllowed` (526) — i.e. once owner-funded, the server never re-checks the sender's own tier/balance for premium access.

**Client wrapper** — `resolveClientBilling` (`packages/shared/src/billing/client-billing.ts:144-168`):
- `ClientBillingInput` (42-58): `tier`, `balanceCents`, `freeAllowanceCents`, `isPremiumModel`, `estimatedMinimumCostCents`, optional `group: { effectiveCents, ownerBalanceCents }`.
- Negative-balance hard block (151-155) reads `group.ownerBalanceCents` when group present, else `input.balanceCents`.
- `deriveClientFundingInputs` (78-104): when `group` present, `memberRemainingNanoUsd` AND `conversationRemainingNanoUsd` both collapse onto the single backend-supplied `effectiveCents` (already the server's clamped min — not re-derived client-side); `ownerPurchasedBalanceNanoUsd = group.ownerBalanceCents`.
- `decision.payer==='owner'` → `fundingSource:'owner_balance'`; `refuse` → `premium_requires_balance`/`guest_budget_exhausted`; else falls to `resolveSelfAffordability` (111-135), the client-only affordability/trial layer additive on top of the core.
- Consumed by `useResolveBilling` (`apps/web/src/hooks/billing/use-resolve-billing.ts:29-51`), fed `tier`/`balanceCents`/`freeAllowanceCents` from `useUserTierInfo(isAuthenticated)` — the **caller's own** tier info.

Test coverage: `packages/shared/src/billing/funding-decision.test.ts:143-171` (guest refuse/owner-fund cases), `funding-decision.contract.test.ts:56-243` (cross-side drift-prevention matrix, client vs server).

---

## 2. Tier inheritance for owner-funded math

### Server: tier is derived from the PAYER WALLET'S KIND, never a stored user-tier field

- `PayerFunding` (`turn-context.ts:96-99`): `{ remainingNanoUsd: bigint; kind: 'purchased' | 'free' }`.
- Owner-funded branch (`turn-context.ts:410-416`) always stamps `kind: 'purchased'` — group funding only ever draws the owner's *purchased* wallet, never the owner's free wallet, regardless of sender state.
- `tierForFunding(funding)` (`apps/api/src/slices/chat/domain/turn-definition.ts:189-191`): `return funding.kind === 'purchased' ? 'paid' : 'free'` — the **sole** tier-derivation function feeding all downstream turn math.
- Call sites, all keyed off `tierForFunding(budget.funding)` in `turn-definition.ts`:
  - `payerSpendableNanoUsd` (199-201): `spendableFundsNanoUsd(budget.funding.remainingNanoUsd, tierForFunding(budget.funding))`.
  - `turnStorageContext` (209-214): `outputCharsPerTokenForTier(tierForFunding(budget.funding))`.
  - `withStorageStamp` (230-240): stamps `definition.storage = { inputChars, tier: tierForFunding(budget.funding) }`, feeding `outputCharsPerTokenForTier(storageContext.tier)` later in `smart-model-turn.ts:71` and `estimate-run.ts:505`.
  - `promptInputTokensFor` (248-250): `estimateTokensForTier(tierForFunding(budget.funding), budget.promptCharacterCount)`.
  - `turnCostBasis` (261-279): `tier = tierForFunding(budget.funding)`, feeds `estimateTokensForTier`/`outputCharsPerTokenForTier`.
- **Conclusion**: for an owner-funded group turn, `estimateTokensForTier`, `outputCharsPerTokenForTier`, `spendableFundsNanoUsd`/`payerSpendableNanoUsd` all run at `'paid'` — inferred from "the payer wallet is a purchased wallet" — regardless of whether the actual sender is `'guest'`, `'free'`, or `'trial'`. Not a DB read of the owner's tier field.
- `getEffectiveBalanceNano` has **zero non-test server call sites** — server uses `spendableFundsNanoUsd` directly (`admission.ts:108`, `turn-definition.ts:200`). Admission's own `spendableFor` (`apps/api/src/slices/billing/domain/admission.ts:101-110`) independently derives `tier = type === 'purchased' ? 'paid' : 'free'` from the **admitted wallet's `WalletType`** — same wallet-kind-not-user-tier pattern, applied to whichever wallet `resolvePayerWallet` chose (the owner's, for a group turn).

### Client: tier is the CALLER'S OWN tier, decoupled from group/owner context

- `useUserTierInfo(isAuthenticated)` (`apps/web/src/hooks/billing/use-user-tier-info.ts:17-43`) derives tier purely from `useBalance()` (the signed-in caller's own wallet) and `getLinkGuestAuth()` (whether the caller itself is a link guest) — no group/owner parameter exists on this hook.
- `use-budget-calculation.ts:178,189-194`: `tierInfo = useUserTierInfo(...)`, `computeBudget(input, { tier: tierInfo.tier, purchasedNanoUsd, freeAllowanceNanoUsd })` — the nano amounts also come from the caller's own `useBalance()`. `UseBudgetCalculationInput` (34-50) has **no `group` field at all**.
- Inside `computeBudget`/`buildRequest` (84-94, 123-160): `estimateTokensForTier(tier,...)`, `outputCharsPerTokenForTier(tier)`, `getEffectiveBalanceNano(balance.tier, balance.purchasedNanoUsd, balance.freeAllowanceNanoUsd)` (134-138) all run against the caller-own tier/balance.
- `use-prompt-budget.ts:431,491`: `tierInfo = useUserTierInfo(isAuthenticated)`, used for `outputCharsPerTokenForTier(tierInfo.tier)` in the Smart Model storage context — again caller's own tier.
- The `group` context (`useGroupBillingContext`, `use-prompt-budget.ts:152-167`, sourced from `useConversationBudgets`) is built separately and fed **only** into `useResolveBilling` (via `buildBillingResolverInput`, 115-136) — i.e. only into the who-pays/denial decision, never into `useBudgetCalculation` or the storage-context tier calc.

**Net effect**: server math for an owner-funded turn runs at `'paid'` (owner's implied tier via wallet kind); client math for the same turn (`maxOutputTokens`, `estimatedMinimumCost`, capacity%, storage ratio) runs at the **sender's own tier** via `useUserTierInfo`, independent of who ends up funding it. No code path found where the client recomputes its budget-display math using the owner's tier for a group turn — only the funding source/denial (`useResolveBilling`) is group-aware. No test found that reconciles client caller-tier math against server owner-tier (wallet-kind) math for the same group turn; `funding-decision.contract.test.ts` pins only the who-pays/premium verdict, not downstream token/storage math.

### Is the guest/member's own tier used anywhere while the owner pays?

Yes, in two places, both decoupled from `resolveFundingDecision`:
- Client display/budget math (above) always uses `tierInfo.tier` (caller's own), never the owner's, regardless of group funding.
- Client model-picker premium gating is entirely independent of group context: `apps/web/src/hooks/models/use-model-validation.ts:27-28` — `canAccessPremium = isAuthenticated && purchasedNano > 0n` from the caller's own `useBalance()`; zero "group" references in this file or `models.ts`.
- Server confirms the opposite for the funding/premium decision itself: `resolvePayerWallet`'s group branch zeroes the sender's own balance before calling the core — `turn-context.ts:393`: `callerOwnPurchasedBalanceNanoUsd: 0n` in the frozen `groupInputs`, comment (382-386) "irrelevant to the owner-funded and guest-refuse verdicts." `tierGateRejection` (`routes.ts:526`) explicitly skips the premium catalog re-check once `baseline.payer !== 'self'`.

(Unrelated, flagged only for completeness: `packages/shared/src/estimate/smart-model-affordability.ts` and `apps/api/src/slices/models/domain/smart-model-candidates.ts` hardcode `'trial'` tier for their own worst-case reserve math — a trial-specific path, not group-funding related.)

---

## 3. Sender vs payer recording at settlement

### Whose wallet is charged

`chargeWithinTx` (`apps/api/src/slices/billing/domain/charge.ts:71-162`) writes `input.walletId`/`input.userId` verbatim into the wallet lock, usage record, and ledger legs (77, 79-89, 111). These originate from `apps/api/src/slices/chat/domain/settlement.ts:1144-1154` (`createChatSettlementCommit`): `context: { walletId: deps.identity.walletId, userId: deps.identity.userId, ... }`.

`deps.identity.userId` is documented at `settlement.ts:116-126`:
> "The PAYER's user account — whose wallet is charged and whose usage the record attributes to (the initiator for a user turn, the OWNER for a guest turn; a guest has no account). NEVER the guest's identity — that rides `sender`."

The separate `sender` field (127-133):
> "The resolved SENDER principal (a member or a link guest, each carrying the `conversation_members.id`)... Drives `messages.senderId`, the member-wrapped epoch gate, and per-member spend."

Flows through `createChargingCommit` (`apps/api/src/slices/workflows/engine/settlement.ts:159-192`): `chargeInputFor` sets `walletId: context.walletId, userId: context.userId` — always the payer, never `identity.sender`.

Naming helpers in `chat/domain/settlement.ts`: `settlementCaller(identity)` (286-290, membership-gate caller = sender), `settlementSenderId(identity)` (293-295, sender's principal id for `messages.senderId`), `settlementSenderUserId(identity)` (302-305, sender's own userId, `undefined` for a link guest).

**Conclusion: the wallet charged is always `deps.identity.walletId`/`userId` — the owner/payer — regardless of who sent the message.**

### Schema — `usage_records` (`packages/db/src/schema/usage-records.ts:14-63`)

Columns: `id`, `userId` (FK→users, SET NULL — **the payer**), `contentItemId` (FK→content_items, SET NULL), `runId` (plain grouping uuid, no run table), `conversationId` (FK→conversations, SET NULL, "stamped at settlement so per-conversation spend analytics can group by it"), `modelId`, `providerName`, `modality`, `generationId`, `costNanoUsd`, `isEstimated`, `idempotencyKey` (unique), `createdAt`.

**No column named `senderId`, `memberId`, `guestId`, `createdBy`, or `linkId` exists.** Only `userId` (payer).

### Schema — `ledger_entries` (`packages/db/src/schema/ledger-entries.ts:16-51`)

Columns: `id`, `transactionId`, `walletId` (FK→wallets, RESTRICT, nullable — the payer's wallet), `houseAccount` (nullable enum), `kind`, `amountNanoUsd`, `balanceAfterNanoUsd` (nullable, wallet legs only), `idempotencyKey` (unique), `paymentId` (FK→payments, SET NULL), `usageRecordId` (FK→usage_records, SET NULL), `createdAt`.

**No sender/actor/member column at all** — `walletId` is the only user-identity indirection, and it's exclusively the payer's.

### Where the sender IS persisted, and how to trace "which guest caused this charge"

Sender identity is written only onto `messages.senderId` for the **user** message — `persistUserMessage` (`settlement.ts:716-719`): `senderId: settlementSenderId(deps.identity)` (comment: "a member's userId, a link guest's linkId — never the paying owner"). The **assistant** sibling message — the one whose content item is actually billed — is persisted with a reserved sentinel instead: `settlement.ts:632-633`, `senderId: ASSISTANT_SENDER_ID` (nil-UUID sentinel, defined line 58).

`contentItemIdByKey` (the map feeding `chargeWithinTx`'s `contentItemId`) is populated **only** inside `persistAssistantSibling` (682-687), never inside `persistUserMessage`. So `usage_records.contentItemId → content_items.messageId → messages.senderId` always lands on the assistant sentinel, not the guest.

The only structural link between the billed assistant message and the sending user/guest message is `messages.batchId` (`packages/db/src/schema/messages.ts:29-35`, "per-turn identifier shared by every message persisted in one settlement"), set once per turn (`settlement.ts:510`, `const batchId = deps.newId()`) and passed to both `persistUserMessage` (721) and each `persistAssistantSibling` call (529). **Recovering "which guest sent this" from a `usage_record` requires a non-FK, application-level join**: `usage_records.contentItemId → content_items.messageId → messages.batchId` → find the sibling `messages` row in the same conversation+batchId with `senderType='user'` → read its `senderId`.

The one direct-but-imprecise link is `member_budgets.memberId`, populated from the sender's `conversation_members.id` via `resolveCallerMember(...)` inside `resolveMemberBudgetAttribution` (`settlement.ts:1055-1100`; doc comment 1048-1049: "re-resolved SERVER-SIDE from the SENDER principal... never from a client-supplied member id"). This is a cumulative running total (unique on `memberId`), not a per-charge attribution row — no `usageRecordId`, `runId`, or per-charge timestamp on `member_budgets`.

**Explicit negative finding: no column on `usage_records` or `ledger_entries` records the sending guest/member for an owner-funded charge.** `usage_records.userId` is always the payer. `ledger_entries` has no user-identity column beyond the payer's `walletId`. Sender recovery requires either the indirect `batchId` join above, or consulting the cumulative (non-per-charge) `member_budgets.memberId` row.

### Schema — `member_budgets` and `conversation_spending`

`packages/db/src/schema/member-budgets.ts:12-28`: `id`, `memberId` (FK→conversation_members, cascade, not null), `budgetNanoUsd` (bigint, notNull, no default), `spentNanoUsd` (bigint, default 0), `updatedAt`. Unique on `memberId` (27) — one row per member, ever. Docstring (6-11): "cumulative forever, no period, no reset job" — **not period-keyed** (no month/date column). Absent row reads as zero cap (deny) — existence of the row is the switch, not a null-valued column.

`packages/db/src/schema/conversation-spending.ts:11-26`: `id`, `conversationId` (FK→conversations, cascade, not null), `spentNanoUsd` (bigint, default 0), `updatedAt`. Unique on `conversationId` (25) — one row per conversation, ever, also cumulative-forever/no-period. The cap itself lives on `conversations.conversationBudgetNanoUsd` (`packages/db/src/schema/conversations.ts:20-22`, bigint, notNull, default 0 — i.e. new conversations deny group funding by default until the owner sets a cap).

### `budget-resolution.ts` — read-only resolver, not a writer

`apps/api/src/slices/billing/domain/budget-resolution.ts` exports `resolveBudgetScopes(stores, db, request)` (63-104). It reads `member_budgets`/`conversation_spending`/`allowance_spending` and computes `remainingNanoUsd = clampNonNegative(cap − spent)` per scope (member: 81-91 keyed by `memberId`; conversation: 93-101 keyed by `conversationId`; allowance: 70-79 keyed by user+day). **It performs no write.**

The actual write (accrual, never decrement/reset) happens in `chargeWithinTx` via `stores.addSpendingWithinTx` (`charge.ts:132-151`), keyed by `{ scope:'member', memberId: input.memberBudget.memberId }` / `{ scope:'conversation', conversationId: input.conversationId }`. `input.memberBudget.memberId` traces to `deps.context.memberBudget.memberId` (`apps/api/src/slices/workflows/engine/settlement.ts:186-189`) → `resolveMemberBudgetAttribution` (`chat/domain/settlement.ts:1055-1100`) → the **sender's** member id (via `settlementCaller(identity)`).

**Key asymmetry**: `member_budgets`/`conversation_spending` accrual is keyed by the SENDER's identity (memberId); `usage_records`/`ledger_entries` charge rows are keyed by the PAYER's identity (userId/walletId). These are the two places in the codebase where sender-vs-payer attribution diverges by design.

---

## 4. Budgets — schema, routes, hooks, remaining formula, admission scopes, exhaustion

### Schema (repeats §3, added detail)

Neither `member_budgets` nor `conversation_spending` has a nullable-for-unlimited column; the cap is a plain `bigint` (`budgetNanoUsd` / `conversations.conversationBudgetNanoUsd`), and "unlimited" is not representable — cap `0` (the table default) denies group funding until explicitly raised. `budgetCapSchema` (`apps/api/src/slices/conversations/domain/budgets.ts:37`) enforces `value >= 0n` only — no upper bound, no relation to current spend.

### Routes (`apps/api/src/slices/conversations/routes.ts`, basePath `/conversations`)

| Route | Method | Handler | Writes |
|---|---|---|---|
| `/conversations/:conversationId/member/:memberId/budget` | PUT | `routes.ts:833-855` → `setMemberBudget` (`domain/budgets.ts:94-111`) | `billing.setMemberBudgetCapWithinTx` → `member_budgets` |
| `/conversations/:conversationId/budget` | PUT | `routes.ts:856-878` → `setConversationBudget` (`domain/budgets.ts:139-158`) | `stores.conversations.updateBudget` → `conversations.conversationBudgetNanoUsd` |
| `/conversations/:conversationId/budgets` | GET | `routes.ts:879-896` → `getConversationBudgets` (`domain/budgets.ts:282-305`) | read-only, composes `billing.readMemberBudget`/`readConversationSpent`/`readWallets` |

Authorization: member-budget PUT requires admin+ privilege (`budgets.ts:105`, `getPrivilegeLevel` comparison, else forbidden); conversation-budget PUT requires owner via a conditional `UPDATE ... WHERE id=? AND user_id=?` (`budgets.ts:139-158`, `adapters/stores.ts:187-195` — never check-then-act); GET is readable by any active member, non-owners see only their own row (`budgets.ts:245-255`). Both PUTs go through `runByKey` (idempotent `byKey` wrapper, `routes.ts:842-852,865-875`).

### Client hooks (`apps/web/src/hooks/billing/use-conversation-budgets.ts`)

- `budgetKeys` (30-33): `all=['budgets']`, `conversation(id)=['budgets', id]`.
- `useConversationBudgets(conversationId)` (35-49): `useQuery`, calls `client.conversations[':conversationId'].budgets.$get`, `staleTime: Infinity`, `enabled: !!conversationId`.
- `ConversationBudgetsResponse` shape (15-28): `conversationCapNanoUsd`, `conversationSpentNanoUsd`, `ownerBalanceNanoUsd`, `members: [{ memberId, userId, username, privilege, capNanoUsd, spentNanoUsd, effectiveRemainingNanoUsd }]`.
- `useUpdateMemberBudget()` (51-71) and `useUpdateConversationBudget()` (73-93): mutations to the two PUT endpoints (converting cents→nano via `centsToNanoUsd`), both invalidate `budgetKeys.conversation(id)` on success.
- Additional invalidation triggers of the same key: `use-realtime-sync.ts:47` (WS `run-finished`, also invalidates `chatKeys.conversation`/`billingKeys.balance()`), `:70` (`member:added`), `:78` (`member:removed`), `:92` (`member:privilege-changed`); `use-conversation-links.ts:16`; `use-conversation-members.ts:55,182`.
- `use-budget-calculation.ts`/`use-prompt-budget.ts` are a *separate* concern (personal affordability/prompt-composer math) — confirmed to never touch `member_budgets`/`conversation_spending` directly.

### "Remaining" formula

Server (`budget-resolution.ts`): member `clampNonNegative(row.budgetNanoUsd - row.spentNanoUsd)`; conversation `clampNonNegative(capNanoUsd - spent)`; `clampNonNegative(v) = v > 0n ? v : 0n` (59-61).

Server display/effective — `groupEffectiveRemainingNanoUsd(memberRemaining, conversationRemaining, ownerBalance)` (`apps/api/src/slices/billing/domain/group-budget.ts:22-34`): clamps each of the three to ≥0 independently, then takes the min. This is **the same helper admission uses** — called both from `resolvePayerWallet`'s decision path (`turn-context.ts:400-404`) and from the display builder (`conversations/domain/budgets.ts:206-213`, feeding `effectiveRemainingNanoUsd` in the GET response). At the display-builder call site, the raw inputs (`memberCap - memberSpent`, `conversationCap - conversationSpent`, `conversations/domain/budgets.ts:207-213`) are unguarded plain bigint subtractions that CAN go negative on overspend — they're clamped only inside `groupEffectiveRemainingNanoUsd`, so `capNanoUsd`/`spentNanoUsd` in the same response are serialized unclamped (e.g. a client can see `cap:100, spent:250, effectiveRemainingNanoUsd:0` simultaneously).

Client: no independent remaining-calc for group budgets — `useConversationBudgets` consumes the server-computed `effectiveRemainingNanoUsd` string verbatim (comment `use-conversation-budgets.ts:10-11`: "the backend's own ... value admission gates on — so the frontend never re-derives it").

### Admission Lua scope hashes

Key builder: `BILLING_KEYS.scopeHolds.buildKey(scopeId) = "billing:admission:scope:${scopeId}"` (`apps/api/src/slices/billing/domain/keys.ts:63-67`); `holdFieldSchema = /^\d+:\d+$/` (18); TTL `MAX_HOLD_TTL_SECONDS` shared across wallet/scope holds. Since `member_budgets`/`conversation_spending` are cumulative-forever (not period-keyed), `scopeId` is simply `member:<memberId>` or `conversation:<conversationId>` (`budget-resolution.ts:85,97`) — no period suffix, despite a key-builder comment implying period-rollover (`keys.ts:60-62`).

DB→Redis: `resolveBudgetScopes` (`budget-resolution.ts`) emits `BudgetScope { scopeId, remainingNanoUsd }` (interface `admission.ts:31-40`). `runAdmissionScript` (`admission.ts:182-206`) builds `KEYS = [walletHolds, ...scopeHolds]` and `ARGV = [...6 fixed, ...budget.remainingNanoUsd.toString(10)]`.

Lua atomic per-scope check (`admission-scripts.ts:38-82`, loop 66-70):
```lua
for i = 2, #KEYS do
  local remaining = tonumber(ARGV[i + 6])
  local scopeSum = activeHolds(KEYS[i])
  if remaining - scopeSum < estimate then return 'budget-exceeded' end
end
```
`activeHolds` (45-61) sums non-expired holds in the scope's hash, lazily HDEL-ing expired ones; only after every scope (plus wallet balance/run-cap) passes does it `HSET` the hold into every KEYS hash (76-79) — no joint over-admission across racers.

### Budget exhaustion mid-period — two mechanisms, a documented discrepancy

**Pre-check** (route-time, one Postgres snapshot read): `resolveFundingDecision` (§1) — exhaustion (`effective ≤ 0n`) refuses a link guest outright (`GROUP_BUDGET_EXHAUSTED`), falls a signed-in member through to `selfFunding`/personal billing. Called from `turn-context.ts:395` and `routes.ts:525,531`; decision made once, from `ResultAsync.combine([readWallets, readMemberBudget, readConversationSpent])` (`turn-context.ts:371-380`).

**Admission-time enforcement** (Lua, later in the same run): `resolveMemberBudgetScopes` (`apps/api/src/slices/chat/domain/runtime.ts:485-562`) does **not** re-run `resolveFundingDecision` — it branches on the already-decided `scope.ownerFunded` boolean (533,539). If self-funded, only `freeTierScopes()` runs (no group scope at all — exhaustion structurally can't retrigger here). If owner-funded, it re-reads **live** `member_budgets`/`conversation_spending` (551-558) and passes those scopes into `admitRun` (587-595). If the Lua script then finds `remaining - scopeSum < estimate` — i.e. the group budget was exhausted by a concurrent run in the race window between the route-time snapshot and this admission call (not the same transaction/lock) — it returns `'budget-exceeded'` (`admission-scripts.ts:69`) → `AdmissionDecision.admitted=false` (`admission.ts:244-249`) → collapsed in `runtime.ts:597-614` to `{ admitted:false, code: ERROR_CODES.INSUFFICIENT_ADMISSION }` (613) — **no re-decision, no fall-through to the sender's personal wallet**. `routes.ts:409` and `:703` map `INSUFFICIENT_ADMISSION` to HTTP 402. The run never enters the workflow engine, so nothing is billed, but the sender is not silently rebilled to their own wallet the way pre-check exhaustion would route them.

**Discrepancy, stated plainly**: the "exhausted ⇒ fall through to personal" behavior exists only at the pre-check layer, and only for a signed-in member sender (a link guest is always refused at that layer too). Once the route has committed to owner-funded, a *later* admission-time exhaustion of the same group scopes is a hard refusal with no fallback re-attempt — the same logical condition (group budget exhausted) is handled differently depending on when it's observed.

---

## 5. Guest specifics

### Link-guest principal (identity slice)

Session-level discriminated union `Principal` (`apps/api/src/lib/context/principal.ts:89-96`) includes `{ kind:'link-guest'; linkId: string; conversationId: string }`. Never derived from a cookie; admitted to no route class by default (doc comment 69-75).

Identity slice module `apps/api/src/slices/identity/domain/link-guest.ts`: `LinkGuestPrincipal` type (15), `resolveLinkGuestPrincipal(args)` (35-54) decodes a base64 `credential` via a `LinkResolutionPort`; malformed or unresolvable credential → `{kind:'none'}` (43,47); resolved → `{kind:'link-guest', linkId, conversationId}` (49-52). Barrel: `identity/domain/index.ts:36-37`; public surface `identity/index.ts:29,44-45`. Tests: `link-guest.test.ts` (94 lines).

Blanket HTTP-level refusal: `apps/api/src/lib/context/route-class.ts:76` — `if (principal.kind === 'link-guest' || principal.kind === 'trial-session') return FORBIDDEN` for every session/billing-token route class.

Downstream re-resolution (each slice maps identity's kebab-case `'link-guest'` to its own local camelCase `'linkGuest'`):
- conversations: `domain/caller.ts:23-25,42-59` (`ConversationCaller`, mapping at 55-57).
- media: `domain/caller.ts:31-46` (mapping at 44).
- chat: `routes.ts:967-993` (`resolveGuestSenderOrRefusal` — verifies credential, checks conversationId match [403, 982], checks active non-read-only membership, returns `TurnSender {kind:'linkGuest', linkId}`, 992).
- Distinguishing downstream: `chat/domain/sender.ts:11-13,20-21,30-33` (`SenderLike`); `turn-context.ts:117-119` (`TurnSender` union), `:389` (`isGuest: sender.kind==='linkGuest'` feeds `resolveFundingDecision`), `:418-427` (deny if guest + no owner headroom), `:482-485`; `runtime.ts:514` (`senderIsGuest`), `:760` (link-guest turns always treated as owner-funded for the settlement hook); media `presign-authz.ts:31-34,75-81` (exhaustive `ts-pattern` match).
- **Billing slice has zero guest references** (`grep -rni guest apps/api/src/slices/billing` → no hits) — it only checks `Principal.kind !== 'full'|'billing-only'` (`billing/domain/balance.ts:15`, `payments.ts:66`); guest exclusion happens entirely upstream at the route-class matrix.
- Shared package type `packages/shared/src/flow-executor.ts:208-210`: `SenderPrincipal = {kind:'user', userId, memberId} | {kind:'linkGuest', linkId, memberId}`, used in `PaidRunIdentity.sender` (230).

### "Guest never pays own funds" enforcement

Core: `resolveFundingDecision` (§1) — guest+exhausted ⇒ unconditional `refuse:GROUP_BUDGET_EXHAUSTED`, no fallback (no self-funding call at all for that branch).

Billing's `admitRun` does not itself know about guests — it takes an already-resolved `walletId`; the refusal happens upstream in the chat slice, before any Redis hold is attempted.

Independent server re-check (defense-in-depth, not just trusting the core's refusal code): `turn-context.ts:418-427` — explicit `if (args.sender.kind === 'linkGuest') return errAsync(forbiddenError('chat turn: link guest has no funds and the owner cannot cover the turn'))`.

Client re-check: `client-billing.ts:128-130` (`resolveSelfAffordability`) — `if (tier === 'guest') return {fundingSource:'denied', reason:'guest_budget_exhausted'}`.

Tests: `funding-decision.test.ts:143-171`; `funding-decision.contract.test.ts:189-243`; `turn-context.test.ts:506-563` (positive owner-funded + negative denied-guest cases, asserts `code==='forbidden'`); `settlement.integration.test.ts:1999-2075` — full DB proof that settlement charges the owner's wallet while `messages.senderId` records the guest's `linkId` (2070).

### Wire error code path for guest denial

`GROUP_BUDGET_EXHAUSTED` never crosses the wire as its own code — not present in `packages/shared/src/error-codes.ts`. `turn-context.ts:423-426` maps it to a generic `forbiddenError(...)` → `domain-error.ts:66` (`forbiddenError = factoryFor('forbidden')`) → `error-codes.ts:270` (`DOMAIN_ERROR_CODE_TO_WIRE_CODE.forbidden = 'FORBIDDEN'`) → `routes.ts:77-86` (`STATUS_BY_DOMAIN_CODE.forbidden = 403`) → `routes.ts:288-290`/`:1101-1136` (`POST /chat/guest`) → **HTTP 403, `{code:'FORBIDDEN'}`**. Billing's `admission.ts` is not involved in this path (denial happens before any admission hold is attempted).

Client does not parse this 403 to produce its copy — it independently re-derives the same denial pre-send via the shared pure core (`client-billing.ts`), disabling the composer before the request is even sent (`use-prompt-budget.ts:232-251,507-523,539-551` → `hasBlockingError`; `prompt-input.tsx:53-60` `canSubmitMessage` returns false).

### Client-side guest experience

Guest identified client-side via `apps/web/src/lib/link-guest-auth.ts:1-13` (`getLinkGuestAuth()`) + `isAuthenticated=false` ⇒ tier `'guest'` (`packages/shared/src/tiers.ts:26,48-58`).

- Premium overlay suppressed for guests: `model-selector-types.ts:9-10` (`isLinkGuest?`), `model-list-item.tsx:389` — `showOverlay = isPremium && !canAccessPremium && !isLinkGuest`.
- Labeling: `budget-settings-modal.tsx:267-268` ("A member row with no user is a link guest" → label `'Guest Link'`); `member-row.tsx:59` (`'Guest'` when `username===null`); `invite-link-modal.tsx:231-235` (owner-facing copy: "To let link guests send messages, allocate them a budget in Budget Settings"); `member-sidebar-footer.tsx:59,70` (`'Your Budget'` read-only label for non-admin members/guests vs `'Budget Settings'` for admins/owner); `chat-layout.tsx:394` (guests get no "leave conversation" action); `authenticated-chat-page.tsx:335-342,413` (`isLinkGuest = privateKeyOverride != null`; loading guest defaults `callerPrivilege` to `'read'` to avoid a notification flash).
- Notification rendering: `prompt-input.tsx:873` (`<BudgetMessages errors={budget.notifications} />`); `budget-messages.tsx:126-181` — inline `role="alert"` banner (not toast), colored left border by type, dismissible except `error` type (56-58).

### Guest-facing copy (`packages/shared/src/budget.ts`)

- `guest_budget_exhausted` (88-93, error, non-dismissible): **"No budget allocated. Contact the conversation owner."**
- `delegated_budget_notice` (119-128, info, shown when `fundingSource==='owner_balance' && hasDelegatedBudget===true`): **"You won't be charged. The conversation owner has allocated budget for your messages."**
- `delegated_budget_exhausted` (130-135, info, shown when `hasDelegatedBudget===true` but funding fell through to something other than `owner_balance`): **"Allocated budget used up. Your personal balance will be used."** (applies to signed-in delegated members with a personal wallet — a true guest has none, and this notice is explicitly suppressed for guests: 229-236, "the `guest_budget_exhausted` denial error already covers it").
- `read_only_notice` (192-201, short-circuits all other notifications when privilege is `'read'`): **"You have read-only access to this conversation."**

`generateNotifications` full ordering (203-244): capacity_exceeded → denial error → warnings → info notices (funding-source, then delegated). Server-side: **zero** usage of `generateNotifications`/`BudgetError` anywhere under `apps/api/src` — this is a purely client-side (shared-package) vocabulary, distinct from the API's `{code}`/`friendlyErrorMessage()` path (per `docs/CODE-RULES.md`).

Tests: `packages/shared/src/budget.test.ts` (1009 lines) — `:59-69` guest message pin, `:71-80` suppression-of-delegated-exhausted-when-guest-denied, `:242-288` delegated-notice message pin, `:311-975` full scenario matrix (groups D-H covering active/exhausted-to-paid/exhausted-to-free/exhausted-to-guest/read-only).

---

## 6. Client-side hooks: `use-prompt-budget.ts` group paths

### `useGroupBillingContext` — the owner-funded estimate inputs

`apps/web/src/hooks/billing/use-prompt-budget.ts:152-167`:
```ts
function useGroupBillingContext(isGroupMember, data) {
  if (!isGroupMember || !data) return;
  const memberRow = data.members[0];
  const effectiveCents = memberRow === undefined ? 0 : nanoUsdToCents(memberRow.effectiveRemainingNanoUsd);
  const ownerBalanceCents = nanoUsdToCents(data.ownerBalanceNanoUsd);
  return { effectiveCents, ownerBalanceCents };
}
```
- `effectiveCents` ← `data.members[0].effectiveRemainingNanoUsd` from `useConversationBudgets` — the **backend-computed** group figure (a non-owner viewer's response carries only their own member row), not re-derived client-side (comment 143-151).
- `ownerBalanceCents` ← `data.ownerBalanceNanoUsd` — the **conversation owner's** wallet balance, not the viewer's.
- `resolveIsGroupMember` (174-181): `isGroupMember = conversationId != null && privilege != null && privilege !== 'owner'` — "Owners pay from their own balance regardless; only members route through the group budget gate."
- `resolveGroupBudgetArgument` (81-88): `null` unless `isGroupMember` — disables `useConversationBudgets` for owners/solo turns.
- `resolveHasDelegatedBudget` (95-107): `isGroupMember && memberRow !== undefined && nanoUsdToCents(memberRow.capNanoUsd) > 0`.
- `buildBillingResolverInput` (115-136): spreads `group: groupContext` into the `useResolveBilling` input only when defined.
- `isReadOnly` (537): forces `hasBlockingError=true`, `fundingSource:'denied'` (540,547) independent of group funding.

### Whose tier/balance feeds the owner-funded estimate

Tier (chars-per-token/cushion sizing): `tierInfo = useUserTierInfo(isAuthenticated)` (431), used at 491 for `outputCharsPerTokenForTier(tierInfo.tier)` — the **viewer's own** tier, from their own `useBalance()`; called exactly once, no swap when `isGroupMember`.

Balance (affordability/who-pays): `resolveClientBilling` — `payerBalanceCents = input.group === undefined ? input.balanceCents : input.group.ownerBalanceCents`; negative ⇒ denied `insufficient_balance`. For group turns this checks the **owner's** balance. `groupHeadroom`/`resolveFundingDecision`: when `effective > 0n`, short-circuits to `fundingSource:'owner_balance'` **without** consulting `callerOwnPurchasedBalanceNanoUsd` — the caller's own balance enters only via `resolveSelfAffordability` when group headroom is exhausted.

**Summary**: the composer/viewer's own tier sizes the estimate (chars-per-token/cushion/`maxOutputTokens`); the owner's balance drives affordability/who-pays for group turns. These are two independently-sourced quantities feeding the same displayed estimate.

### `useConversationBudgets` (repeats §4, hook-level detail)

Query key `budgetKeys.conversation(id)`; endpoint `GET /conversations/:conversationId/budgets`; return shape `ConversationBudgetsResponse` (§4); `staleTime: Infinity`; invalidated by budget-edit mutations plus WS events `run-finished`, `member:added`, `member:removed`, `member:privilege-changed` (`use-realtime-sync.ts:47,70,78,92`), and member/link mutation success (`use-conversation-links.ts:16`, `use-conversation-members.ts:55,182`).

### Tests pinning group/owner-funded client behavior

`use-prompt-budget.test.ts`, `describe('group budget wiring')` (from 273): no-group-context-for-solo (265); null budget query for owners (274); group context passed when data available, with an exact numeric example — `effectiveRemainingNanoUsd:'5000000000'→effectiveCents:500`, `ownerBalanceNanoUsd:'50000000000'→ownerBalanceCents:5000` (286); zero-effective-cents on empty members list (342); **negative owner balance threaded into group context for composer denial** — `ownerBalanceNanoUsd:'-1000000000'→ownerBalanceCents:-100` (368); no group context while loading (403); `hasDelegatedBudget` wiring to notifications (421); no `delegated_budget_exhausted` when member cap is 0 (458); read-only privilege block/denial/notice (668-707); group-budget-loading blocks members but not owners (776-855).

`use-conversation-budgets.test.ts`: enable/disable on conversationId (67,80); `staleTime: Infinity` pinned explicitly (93); typed NanoUSD fields (105); correct queryFn client path (138). WS-invalidation not covered in this file (gap — lives in `use-realtime-sync.ts`, whose own test file was not opened by this research).

`use-resolve-billing.test.ts`: `owner_balance` when group budget available (127); falls through to personal when group budget exhausted (141); **denies with `insufficient_balance` when the group owner balance is negative even though `effectiveCents` is positive (500)** — the owner-balance check takes priority over the already-clamped effective figure (156); denies `insufficient_balance` for negative solo caller balance (173).

---

## 7. Edge cases

### Owner tier changes mid-period

No cache/invalidation is keyed to "tier change" — tier isn't a mutable field; it's derived positionally from `wallets.type`, documented immutable per wallet (`billing/domain/keys.ts:34-36`, "immutable per wallet, so caching it can never go stale").

Two distinct reads: (1) turn-context funding resolution is a **fresh, uncached DB read every turn** — `resolvePayerWallet` → `billing.readWallets(db, ownerUserId)` → plain `db.select().from(wallets).where(eq(wallets.userId,userId))` (`stores.ts:458-471`), run fresh inside `resolveTurnContext` on every `POST /chat` (`routes.ts:1027,1126,1205`). (2) Admission-time balance is a **30s-TTL Redis snapshot** (`billing:admission:snapshot:<walletId>`, `keys.ts:68-75`, `SNAPSHOT_TTL_SECONDS=30`, `constants.ts:34`), invalidated by write-through CAS on `ledgerSeq` on every ledger-committing transaction (`SNAPSHOT_CAS_SCRIPT`, `admission-scripts.ts:119-126`) plus a best-effort post-settlement refresh (`withPostCommitSnapshotRefresh`, `runtime.ts:653-670`); absent a commit, staleness bound is the 30s TTL.

Grep across `apps/api/src` and `packages/db` for `ownerId`/`owner_id`/`fundedBy`/`funded_by`: zero matches. The owner is `conversations.ownerUserId` — actually `conversations.userId` per §7 deletion finding below — resolved fresh per call via `stores.conversations.get(conversationId)` (`turn-context.ts:195-208`).

### Owner balance goes negative

The admission Lua script checks exactly one `walletId` per run (the owner's, for a group turn — chosen at route time regardless of composer, `turn-context.ts:396-417`). A negative owner balance never reaches the Lua script in that negative state — it's clamped upstream: `groupHeadroom` clamps `ownerPurchasedBalanceNanoUsd` (and member/conversation remaining) to ≥0 via `clampNonNegative` before the min, so a negative owner balance clamps to `0n` ⇒ `effective ≤ 0` ⇒ the `payer:'owner'` branch is skipped entirely (`funding-decision.ts:113-127`). Consequence: a signed-in non-owner member falls through to self-funding on their own wallet; a link guest is refused outright with `GROUP_BUDGET_EXHAUSTED` (`turn-context.ts:423-427`) since a guest has no fallback wallet. Confirmed by test: negative owner balance denies with `insufficient_balance` client-side even when `effectiveCents` is still positive (`use-resolve-billing.test.ts:156`).

### Owner deletes their account

Owned conversations are **hard-deleted**, not reassigned. No ownership-transfer mechanism exists (grep for `ownerId`/`transferOwner`/`reassign` in `conversations` and `billing` slices: zero hits). Schema: `conversations.userId` (there is no separate `ownerId` column — `userId` IS the owner/funder) has FK `onDelete:'cascade'` to `users.id` (`packages/db/src/schema/conversations.ts:13-15`).

Deletion transaction `runDeletionTransaction` (`apps/api/src/slices/identity/domain/deletion.ts:323-345`): captures owned conversation ids, captures their storage keys, leaves all memberships, detaches message senders, then explicitly `deleteOwnedConversationsWithinTx` (`apps/api/src/slices/conversations/adapters/account-deletion.ts:43-48`, explicit `DELETE FROM conversations WHERE user_id=:userId`, ordered before `deleteUserWithinTx` to avoid a Postgres "tuple already modified" conflict against membership rows already soft-updated in the same transaction — comment 33-41; the cascade FK would fire the same result if the explicit delete were absent). Downstream cascades: `conversation_spending.conversationId → conversations.id` (cascade) and `member_budgets.memberId → conversation_members.id` (cascade, second-hop once `conversation_members` cascades from the deleted `conversations` row) are both deleted along with the owned conversation. For conversations the deleted user does NOT own: their membership row is soft-departed (`leftAt` stamped) and `conversation_members.userId` is `SET NULL`; their sent messages' `senderId` (plain uuid, no FK) is nulled via `detachMessageSendersWithinTx`.

Gap noted by the research agent: in-flight-turn behavior at the exact moment of owner deletion was not checked.

### Member removed from conversation

Both `removeMember` (`apps/api/src/slices/conversations/domain/members.ts:278-328`) and `leaveConversation` route through `rotateOutDeparture` (335-356) → `stores.members.markLeft(...)` — a **soft update only**: `UPDATE conversation_members SET left_at=now() WHERE id=? AND conversation_id=? AND left_at IS NULL` (`adapters/stores.ts:421-435`).

No code in the removal/leave path touches `member_budgets` (grep for `member_budgets`/`memberBudgets` in `conversations` slice hits only an unrelated comment and a budget-display test). `member_budgets.memberId → conversation_members.id` has `onDelete:'cascade'`, but since `conversation_members` rows are never hard-deleted on removal/leave (only `left_at` set — permitted by the `conversation_members_identity_or_left_check` constraint), the cascade never fires. **The removed/departed member's `member_budgets` row is left in place, untouched** — cap and cumulative `spentNanoUsd` persist indefinitely.

### Budget lowered below already-spent amount

No validation compares a new cap to current-period spend. The only guard is non-negativity: `budgetCapSchema = NanoUSD.refine(v => v >= 0n, 'cap must be non-negative')` (`conversations/domain/budgets.ts:37`). `setMemberBudgetCapWithinTx` (`billing/adapters/stores.ts:520-534`) upserts `budgetNanoUsd` unconditionally on conflict, never reading `spentNanoUsd` first. Grep across `conversations` and `billing` for cap-vs-spent comparison patterns: no matches. `budgets.integration.test.ts` has exactly one cap-rejection test (negative-cap boundary, line 467); no test for "rejects budget below spent"; an overspent state is reachable in tests only via a direct DB insert bypassing the route (~line 555).

As noted in §4, the served "remaining" figure is clamped only at the `groupEffectiveRemainingNanoUsd` output — the raw `capNanoUsd`/`spentNanoUsd` fields in the same `GET .../budgets` response are unclamped, so a client can observe `cap:100, spent:250, effectiveRemainingNanoUsd:0` simultaneously once overspent.

---

## Gaps and open questions flagged by the research agents

- No test found reconciling client-side caller-tier budget/estimate math against server-side owner-tier (wallet-kind) math for the same owner-funded turn — only the who-pays/premium *decision* itself is contract-tested across both sides (`funding-decision.contract.test.ts`), not the downstream token/storage sizing math.
- `resolveMemberBudgetScopes` (`runtime.ts:485-562`) was traced for control flow but not exhaustively line-by-line; the exact race window between the turn-context DB snapshot and the up-to-30s-stale admission Redis snapshot was not measured/tested against.
- `use-realtime-sync.test.ts` was not opened — WS-driven `budgetKeys` invalidation (run-finished, member add/remove/privilege-change) is confirmed in source but not confirmed to have direct unit coverage.
- Epoch/shared-link cascade behavior off an owned conversation's deletion was not inspected (out of scope of the group-billing question set).
- Admin-plane/auditor interaction with orphaned `member_budgets` rows (removed members) was not checked.
- Notification/email templates (`apps/api/src/slices/notifications/domain/templates/`) were not swept for group-budget-specific email content — only the client-side in-app notification vocabulary (`packages/shared/src/budget.ts`) was confirmed.
