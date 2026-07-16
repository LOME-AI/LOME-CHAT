# Message Cost + Model Display Fix — Handoff & Execution Plan

**Status:** Planned, not started. Research complete. Awaiting execution.
**Audience:** An engineer completely new to this thread. Everything you need is here.
**Owner handing off:** (prior session) — all findings below are cited to `file:line` and were
verified against the code unless marked *Inferred*.

> **What this is:** a product bug fix (chat messages don't show the cost we billed or the model
> that answered) plus two related changes, discovered while building a marketing video ad. The ad
> work depends on the product fix, so both are planned together here. Read §1–§3 for the "why",
> §4 for the exact bugs, §5 for the data model you must understand, §6–§10 for the plan, §11 for
> what's already done, §12 for constraints, §13 for the task breakdown.

---

## 1. TL;DR — the ask

The chat UI has a per-message cost label (`MessageCost`) and a model nametag, but **neither
renders on settled messages** — for real users, not just in the demo. We are fixing that. Three
founder decisions govern the work:

1. **(Option B)** Compute the displayed per-message cost as the **actual total we billed** (sum of
   all charges for that message, including the Smart Model classifier), and fix it *by completing
   the existing denormalized `content_items.cost_nano_usd` mirror at settlement* — not by adding a
   read-time billing query. (Why B over the alternative: §6.)
2. **Fix the "Smart" chip bug** — `content_items.is_smart_model` is never written `true`, so the
   Smart chip never shows. Fix it in the same settlement change.
3. **Default the model picker to the strongest model** (currently defaults to Smart Model), using
   the existing "strongest model" calculation. (§9.)

Plus the demo/ad work that motivated the discovery: mirror the product fix in the demo mock
backend, attribute demo replies to the **selected** model, and rewrite the ad capture (§10–§11).

**One product question is still open** (does not block the display fix): whether the Smart Model
classifier cost should be billed to the user (current: yes, pass-through) or absorbed. See §3.

---

## 2. Background — how we got here

We were producing a 30-second video ad (`ads/2026-07-hq-tour/`). Scene 5 films the **real app**
(via its `/demo` mode) doing: open a conversation → switch models mid-thought → a reply streams in
→ hold on a frame showing the **encryption badge and the cost**. Building the capture surfaced
that the demo's settled messages show no cost. Investigating *why* revealed it's not a demo
artifact — **production has the same gap**. The create-ad doctrine forbids faking UI ("the real
app only; every line a checkable fact"), so an ad can't show a cost the product doesn't. Hence:
fix the product first, then the demo naturally shows the real thing, then capture the ad.

The demo (`apps/web/src/demo/`) is the **real app** booted with a mock backend (a `fetch`/`WebSocket`
shim over an in-memory `DemoBackendStore`). Two boot modes: **live** (an autonomous "director"
auto-plays; used by the marketing embed) and **frozen** (`?frozen=1`, static, no director,
externally driveable; used by a screenshot generator — and, per this plan, by the ad capture).

---

## 3. Decisions

### Locked
- **D-A (Option B):** displayed message cost = the billed total. Implement by completing the
  `content_items.cost_nano_usd` denormalized display mirror at settlement so it includes *every*
  charge anchored to the content item (its own generation + the Smart Model classifier + any
  future auxiliary charge). The read path then just exposes the column. (§6, §7.)
- **D-B (chip fix):** persist `content_items.is_smart_model = true` for Smart Model answers at
  settlement (currently never set). Same settlement change as D-A. (§4 bug 3, §7.)
- **D-C (strongest default):** the text model picker defaults to the **strongest** model instead of
  Smart Model, using the existing `getAccessibleModelIds(...).strongestId` calc. (§9.)
- **D-D (demo attribution):** the demo attributes each reply to the **selected** model and the
  hardcoded model is removed from fixtures. (§10.)
- **Reuse `demo-welcome` verbatim** as the ad conversation. (§11.)

### Open (surface to the founder; the first does NOT block the display fix)
- **Pricing of the Smart Model classifier.** Today the classifier is a real second model call that
  **hits the user's wallet** (pass-through). The billing grain (two `usage_records` rows) is
  correct and stays. The open question is pricing policy: keep pass-through (show the summed cost,
  transparent) or **absorb** the routing cost (post the classifier charge to a house account so it
  never hits the user; then the displayed cost is just the answer). This is a *billing-side* change
  independent of the display fix. Default assumption if unanswered: **keep pass-through** (Option B
  displays whatever was billed).
- **Group-transcript model attribution in the demo.** Once `DemoTurn.modelName` is removed (D-D),
  group conversations have no picker to attribute to. Decide: seed a literal model on group fixture
  messages, or a constant. (§10.)
- **Scope of D-C.** Read literally, "the model picker" = the real app product-wide (every user's
  text default becomes the strongest model instead of Smart Model — a notable UX change since Smart
  Model is the current flagship default). Confirm product-wide is intended (it also changes the
  demo default, which affects the ad's switch narrative — §11).
- **Empirical confirmation.** The "production doesn't render cost/model" conclusion is traced
  statically (high confidence). Confirm on a running instance once the dev stack is up (drive one
  real turn, look for the cost label) before/at the start of execution.

---

## 4. The bugs (root cause + evidence)

All four are linked; the fix touches settlement (write), the conversations history endpoint (read),
the web client, and `packages/shared` (a formatter).

**Bug 1 — cost never shows on settled messages.** The message list is fed by
`GET /conversations/:id/messages`, whose content-item projection is deliberately "slim" and carries
no cost (`apps/api/src/slices/conversations/domain/content-item-view.ts:11-31`). The client adapter
then hardcodes `cost: null` (`apps/web/src/hooks/chat/chat.ts:113`). `useDecryptedMessages` sums
`item.cost` (`apps/web/src/hooks/crypto/use-decrypted-messages.ts:57-66,111`), gets null, and
`MessageItem` only mounts `<MessageCost>` when `primaryMessage.cost` is truthy
(`apps/web/src/components/chat/message/message-item.tsx:314`). So it never mounts.
*The code's own comments say cost is supposed to render from persisted data after the post-run
refetch* (`apps/web/src/hooks/chat/use-authenticated-chat.ts:251,637`) — the intent exists; the slim
view broke it. Likely a backend-rewrite regression (the history endpoint was slimmed and the fields
dropped).

**Bug 2 — model name never shows on settled messages.** Same slim view + same adapter
(`chat.ts:112` hardcodes `modelName: null`; `pickModelName` at
`use-decrypted-messages.ts:87` then returns null).

**Bug 3 — the "Smart" chip never shows.** `content_items.is_smart_model` is **never written `true`**
by the new settlement path. The only `isSmartModel: true` in the API tree is an unrelated *catalog*
flag (`apps/api/src/slices/models/domain/list-models.ts:193`); `message-write.ts` /
`insertContentItemWithinTx` never set it. So even once the wire carries it, it's always false.

**Bug 4 — the stored per-item cost undercounts Smart Model turns.**
`content_items.cost_nano_usd` is written per content item as
`applyMarkup(charge.baseCostNanoUsd) + (charge.storageFeeNanoUsd ?? 0n)` for **one** generation
(`apps/api/src/slices/chat/domain/settlement.ts:481`). For single-model, multi-model, and
agentic/web-search turns this equals the item's true billed cost. **For Smart Model it does not:**
the classifier is a separate `usage_records` charge anchored to the answer's content item but not
added into `content_items.cost_nano_usd`. So displaying the raw column would show "just the single
model call cost," missing the routing charge. (This is the bug the founder anticipated.)

---

## 5. The billing / cost data model (deep reference — read before touching settlement)

### Tables
- **`usage_records`** (`packages/db/src/schema/usage-records.ts:14-60`) — the authoritative billed
  record, **one row per model-generation-group**. Columns: `userId` (payer, `SET NULL`),
  `contentItemId` (nullable FK → content_items, `SET NULL`; the saved⟺billed anchor), `runId`
  (NOT NULL, groups a turn's charges — there is **no run table**), `conversationId`, `modelId` +
  `providerName` (plain text, no catalog FK), `modality` (enum), `generationId` (OpenRouter id,
  nullable), **`costNanoUsd`** (NOT NULL — the FULL charged amount = marked-up base + additive
  storage fee, i.e. exactly what was debited), `isEstimated`, `idempotencyKey` (`.unique()`).
- **`content_items`** (`packages/db/src/schema/content-items.ts`) — chat-slice-owned. Has
  `costNanoUsd` (bigint, nullable, `content-items.ts:46`), `isSmartModel` (bool, default false,
  `:47`), `modelId` + `providerName` (plain strings, no catalog FK, `:41-45`). The cost column is a
  **denormalized display mirror**, intentionally so display reads need no billing query.
- **`messages`** (`packages/db/src/schema/messages.ts`) — **no cost column**. Has `batchId`
  (`:33`; multi-model peers share it), `sequenceNumber`, `parentMessageId`, `epochNumber`, sender.
- **`llm_completions`** — per-generation **token** detail only (input/output/reasoning/cached
  tokens), **no cost**. **`media_generations`** — per-generation media detail, no cost.
- **`ledger_entries`** — double-entry legs (the real wallet debits), per charge.

**There is NO stored turn-level or message-level total anywhere.** The turn total exists only as
`SUM(usage_records.cost_nano_usd)` grouped by `runId`, and the message total as the sum over the
message's content items. `content_items.cost_nano_usd` is the closest stored value but is per-item
and (for Smart Model) incomplete — which is exactly what Option B fixes.

### Settlement — where cost is written (the change site for D-A/D-B)
Single fenced transaction. `createChatSettlementCommit`
(`apps/api/src/slices/chat/domain/settlement.ts:922-954`), inside `runSettlement`
(`apps/api/src/slices/workflows/engine/settlement.ts:52-59`):
1. `withStorageFees` enriches every charge once (`settlement.ts:928`).
2. `persistTurnContent` groups **billable text charges by originating node**
   (`groupByOriginatingNode`, `settlement.ts:370-383`) → **one assistant sibling message per node**,
   **one content item per charge**, each carrying its own `cost` (`persistAssistantSibling`,
   `settlement.ts:462-494`; the cost formula at `:481`).
3. `createChargingCommit` posts **each charge** via `chargeWithinTx` → **one `usage_records` row per
   charge** (`workflows/engine/settlement.ts:121-129`), anchored via `anchorContentItemId`
   (`:131-150`).

The billed amount is computed identically in two places (so display == debit *for a single
generation*):
- content item mirror: `applyMarkup(charge.baseCostNanoUsd) + (charge.storageFeeNanoUsd ?? 0n)`
  (`settlement.ts:481`).
- actual debit: `applyMarkup(input.baseCostNanoUsd) + input.storageFeeNanoUsd`
  (`apps/api/src/slices/billing/domain/charge.ts:76`).

### The anchor mechanism (key to Option B)
Auxiliary charges (the Smart Model classifier) use a charge key suffix `<node>#classifier` and are
mapped to the base node's content item by **stripping the `#suffix`**
(`workflows/engine/settlement.ts:131-150`; classifier defined in
`apps/api/src/slices/workflows/nodes/smart-model-execution.ts:29-47,177-180`). So multiple charges
can resolve to the same anchor content item. Charge idempotency key = `${runId}:${charge.key}`
(`workflows/engine/settlement.ts:178`).

### Per-turn-shape correctness of `content_items.cost_nano_usd` today
| Turn shape | `content_items.cost` == billed total? | Why |
|---|---|---|
| Single-model, single-step | ✅ | one charge, one content item |
| Agentic multi-step / web search | ✅ | adapter pre-sums steps into one charge (`workflows/nodes/model-call-execution.ts:40-41,156-158`); web search cost is inline in that one `usage.cost` |
| Multi-model fan-out (per message) | ✅ | each branch = one model = one content item; keys `<node>#<index>` (`packages/shared/src/flow-executor.ts:100-106`) |
| **Smart Model** | ❌ **undercounts** | classifier charge anchors to the answer's content item but is not added into `content_items.cost` |

### Money serialization
- Storage: bigint nano-USD (`apps/api/src/slices/billing/domain/money.ts:7-13`).
- Wire: canonical decimal string via `serializeNanoUSD` / `NanoUSD` brand
  (`packages/shared/src/nano-usd.ts:15-32`).
- Display: `nanoUsdToDollarString` / `nanoUsdToCents` (`nano-usd.ts:77-95`) **both truncate to
  cents**. There is **no** full-precision (sub-cent) formatter; `MessageCost` wants e.g.
  `"0.00136000"`. **A new shared formatter is required** (nano bigint → fixed sub-cent USD string).
  `MessageCost` calls `formatCost(cost)` (`apps/web/src/components/chat/message/message-cost.tsx:13`)
  — verify/extend `formatCost` renders small values sensibly.

### Invariants (docs/ARCHITECTURE.md) that constrain the work
- **saved ⟺ billed** — content persisted ⟹ charged, atomically in the one settlement transaction;
  `usage_records` is ground truth for "billed."
- `usage_records.contentItemId` is nullable (`ON DELETE SET NULL`, financial retention) — any
  aggregation must tolerate null, though live message reads still resolve.
- `isEstimated` — `false` for text/video (OpenRouter authoritative inline cost, final), `true` for
  image (deterministic catalog estimate, exact) and the pathological missing-cost fallback. There
  is **no true-up job** (OpenRouter migration). Displayed cost is final. You may surface
  `isEstimated` but it doesn't make image cost inaccurate.

---

## 6. Why Option B (not the read-time alternative)

Two ways to produce the Smart-Model-inclusive total (identical wire + identical client behavior —
the client already sums per-content-item cost via `sumCost`):

- **Option A (rejected):** a new published billing read `readBilledCostByMessages` summing
  `usage_records`, composed into the history endpoint. Correct-by-construction and drift-proof, but
  it **reverses a deliberate architecture decision** (the codebase denormalized display cost onto
  `content_items` *specifically to avoid* a billing query on the display path) and adds a cross-slice
  read + a per-history-load query. Reversing a deliberate design needs explicit buy-in (CODE-RULES
  "Changing the Architecture").
- **Option B (chosen):** complete the denormalized mirror at settlement so
  `content_items.cost_nano_usd` = the sum of *all* charges anchored to the content item, and set
  `is_smart_model` when a classifier charge is among them. The read path stays simple; boundaries
  stay clean (conversations already reads `content_items`, never billing tables); only a *display*
  value changes (never the debit). Its one weakness — a denormalized value can drift if a future
  charge type is forgotten — is closed by a **settlement invariant test**:
  `Σ content_items.cost == Σ usage_records.cost` per run, across all four turn shapes.

---

## 7. Product fix — layer by layer (Option B)

Order matters: settlement write → history read → shared formatter → client un-null → share
regression test. Everything is TDD (write the failing test first). The settlement change is
**sensitive (money)** → audit panel of three (correctness / security / conventions).

### 7.1 Settlement write (chat slice) — SENSITIVE
**File:** `apps/api/src/slices/chat/domain/settlement.ts` (and its stores/ports as needed).
- Change the content-item cost written in `persistAssistantSibling` (`:462-494`) from *this
  generation's* charge to **the sum of every charge anchored to this content item** — i.e., group
  the run's full charge set by resolved anchor (reuse the `#suffix`-stripping rule from
  `workflows/engine/settlement.ts:131-150`) and write, per content item,
  `Σ (applyMarkup(baseCost) + storageFee)` over its anchor group.
- Set `is_smart_model = true` on a content item when its anchor group contains a classifier charge
  (`<node>#classifier`). (Fixes bug 3.)
- **Do not change the actual debit** — `usage_records`/ledger stay per-charge. Only the display
  mirror changes.
- **Invariant test (required):** for single-model, agentic/web-search, multi-model, and Smart Model
  turns, `Σ content_items.cost_nano_usd == Σ usage_records.cost_nano_usd` for the run.
- **Acceptance:** a Smart Model turn's answer content item has `cost == answer + classifier` and
  `is_smart_model == true`; all other shapes unchanged; the invariant test passes; existing
  settlement tests (`settlement.integration.test.ts`, `smart-model-turn.*`) stay green.

### 7.2 History read (conversations slice)
**Files:** `apps/api/src/slices/conversations/ports/stores.ts`,
`apps/api/src/slices/conversations/adapters/stores.ts`,
`apps/api/src/slices/conversations/domain/history.ts`,
`apps/api/src/slices/conversations/domain/content-item-view.ts`.
- Extend `ContentItemRow` (`ports/stores.ts:94-102`) with `costNanoUsd: bigint | null`,
  `modelId: string | null`, `isSmartModel: boolean`.
- Add those three columns to the `contentItemsByMessage` SELECT
  (`adapters/stores.ts:973-991`; `contentItems` already imported). **No migration** — the columns
  exist.
- **Do NOT widen the shared `contentItemView` / `contentItemViewSchema`** — it is reused by the
  **unauthenticated public-share read** (`domain/shares.ts:680-698` via `selectSharedMessage`),
  which legacy deliberately strips of model/cost/smart metadata
  (`apps/api/src/legacy/routes/message-shares.ts:111-115`). Add a **history-only** projection:
  either a `historyContentItemViewSchema` extending the base with
  `modelName: z.string().nullable()`, `cost: z.string().nullable()`, `isSmartModel: z.boolean()`
  plus a `historyContentItemView(row)`, or build the three fields inline in `historyMessageView`
  (`history.ts:81-93`). Map `modelName = row.modelId`,
  `cost = row.costNanoUsd === null ? null : serializeNanoUSD(row.costNanoUsd)`,
  `isSmartModel = row.isSmartModel`.
- Point `historyMessageSchema.contentItems` (`history.ts:25`) at the history projection.
- Wire propagation is **automatic** via `AppType` inference (the history schema lives in the api
  domain and reaches the client through the typed `hc` client — no `packages/shared` edit for the
  history wire). Route handler (`routes.ts:968-985`) is unchanged (routes hold no logic).
- **`model_id` IS the display name** — it's the OpenRouter model id string (e.g.
  `anthropic/claude-sonnet-4`); the UI treats it as the name, no catalog join
  (`apps/web/src/hooks/chat/use-optimistic-messages.ts:91`).
- **Acceptance:** the history endpoint returns `cost` (NanoUSD string or null), `modelName`,
  `isSmartModel` per content item; the public-share read still returns none of the three (regression
  test); no migration; boundaries intact (conversations reads only `content_items`).

### 7.3 Client (web) — stop nulling
**File:** `apps/web/src/hooks/chat/chat.ts`.
- Add `modelName`, `cost`, `isSmartModel` to `HistoryContentItem` (`:66-73`) and read them in
  `toContentItemResponse` (`:100-116`) instead of hardcoding null.
- Downstream is automatic: `sumCost`/`pickModelName`/`pickIsSmartModel`
  (`use-decrypted-messages.ts:57-121`) and `MessageItem`'s `primaryMessage.cost` gate
  (`message-item.tsx:314`) light up. **`sumCost` already totals a message's content items**, so a
  multi-part message's cost is summed correctly with no logic change.
- **Acceptance:** a settled AI message renders its cost + model + (Smart chip when smart); a
  multi-content-item message sums correctly.

### 7.4 Shared full-precision cost formatter
**File:** `packages/shared/src/nano-usd.ts` (+ wherever `formatCost` lives).
- Add a sub-cent NanoUSD→USD display formatter; ensure `MessageCost`'s `formatCost` shows small
  values (not `$0.00`). Wire value stays the `NanoUSD` string; the client formats.
- **Acceptance:** a sub-cent cost renders with meaningful precision.

---

## 8. (Reserved — Option A is not being built.)

---

## 9. D-C — default the model picker to the strongest model

**Current behavior:** the text picker defaults to **Smart Model**. `DEFAULT_MODEL_ID = SMART_MODEL_ID`
(`apps/web/src/stores/model.ts:21`). `useResolveDefaultModel`
(`apps/web/src/hooks/models/use-resolve-default-model.ts:42`) is a **no-op for text** — its comment
says *"Text is a no-op because the store's subscriber guard always keeps a Smart Model entry in
`selections.text`."* So the Smart-Model text default is enforced by a **store subscriber guard in
`stores/model.ts`** (find it — it re-injects Smart Model into `selections.text`).

**The "strongest model" calc already exists:**
`getAccessibleModelIds(models, premiumIds, canAccessPremium, 'text').strongestId`
(`apps/web/src/hooks/models/models.ts:87-130`) → `findStrongestAndValueTextModels`
(`:61-82`). "Strongest" = **most expensive non-premium** text model (excludes Smart Model + premium,
sorts by `getModelCostPer1k` desc, takes `[0]`); tier-aware (paid users resolve to
`STRONGEST_TEXT_MODEL_ID` premium pin when no basic pool). Already consumed by
`use-model-validation.ts:105`.

**The change (frontend only):** make the text default resolve to `strongestId` instead of Smart
Model. This means:
- Change the store's Smart-Model text subscriber guard in `apps/web/src/stores/model.ts` (the
  invariant that keeps `selections.text` = Smart Model) so text defaults to the strongest model.
- Likely make `useResolveDefaultModel`'s text branch non-no-op: resolve strongest via
  `getAccessibleModelIds(...).strongestId`, find the model, set it as the default text selection.
  Note the resolver already has `models`, `premiumIds`, `canAccessPremium`, `balance`, `session` in
  scope — the same inputs `getAccessibleModelIds` needs.
- Watch the interaction between the store guard and the resolver (the guard currently *wins* for
  text — both must agree on the new default, or the guard will re-inject Smart Model).
- **Sensitive-ish** (touches what every user pays by default) — treat the acceptance carefully.
- **Open:** confirm product-wide scope (§3) and what "strongest" should be when the catalog is empty
  / for a signed-out trial user (the calc has fallbacks; make the choice explicit).
- **Acceptance:** a fresh text conversation defaults the picker to the strongest accessible model
  (not Smart Model); the label reflects it; existing model-store/validation tests updated; the
  guard no longer forces Smart Model on text.

---

## 10. Demo mirror + D-D (attribute to selected model)

All in `apps/web/src/demo/`. The demo is the real app + mock backend, so it must mirror the product
wire so the same client adapter reads real values.

### 10.1 Attribute replies to the selected model; drop the fixture model
- Rewire `appendTurn` (`apps/web/src/demo/mock-backend/store.ts:483-548`) so the reply's
  attribution and `SendTurn.modelId` come from the **caller's `modelId`** (the sent/selected model
  from `recordSendTurn`), not `turn.modelName`. Today it uses `turn.modelName` at `:514-517` and
  `:543`; the sent model already flows in via `fetch-shim.ts:192`
  (`body.models?.[0] ?? body.model`). Keep `turn.isSmartModel` for the chip.
- Remove `DemoTurn.modelName` (`apps/web/src/demo/mock-backend/fixtures.ts:49`) and the AI-side
  `DemoMessage.modelName` (`:57`), and delete the per-turn `modelName:` values in
  `DEMO_CONVERSATIONS` (`fixtures.ts:104,118,138,152,170,200,212`). **Decide group attribution**
  (`store.ts:831`, `fixtures.ts:57`) — no picker in group replay; seed a literal (open decision §3).
- `regenerateModelId` (`store.ts:185-188`) already prefers `models?.[0]`; fine after the field is
  removed.
- Update tests: `store.test.ts:96-104` (assert the **sent** model, not `'openai/gpt-4o'`) and
  `store.test.ts:472-484`.

### 10.2 Carry cost/model/isSmartModel through the demo history wire
- Extend `DemoMessagesPage.contentItems` type (`store.ts:114-122`) and the `getMessagesPage` mapper
  (`store.ts:276-283`) to include `modelName`/`cost`/`isSmartModel` from the stored item (stop
  dropping them). **In lockstep** with the product `HistoryContentItem` + `toContentItemResponse`
  change (§7.3) — otherwise the demo's settled message shows null after refetch.
- Update the "slim history wire shape" test `store.test.ts:229-260` (the exact-match `toEqual` at
  `:251-258` will fail; add the three keys).

### 10.3 Seed a realistic cost on fixtures
- There is **no per-fixture cost field today** (`DemoTurn` = `user, ai, modelName?, isSmartModel?`;
  `buildContentItem` writes `cost: null` at `store.ts:873`). Add an optional `DemoTurn.cost` (a
  NanoUSD wire string matching `ContentItemResponse.cost`), seed it on the demo-welcome AI turns,
  and thread it into `appendTurn` attribution + `buildContentItem` (replace the `cost: null`
  literal). Then cost flows fixture → store → `getMessagesPage` → history → client → `MessageCost`.
- New tests: a store test that a seeded per-turn cost surfaces on the content item and through
  `getMessagesPage`.

### Note on the demo contract test
`store.contract.test.ts` pins **only** `getBalance` to the real `AppType` (not messages/history —
the demo `getMessagesPage` returns a hand-rolled `DemoMessagesPage`, mirrored from the route-local
`HistoryMessage`, not a shared schema). So the cost/model mirror is **not** auto-cross-checked. If a
guard is wanted, extend the contract test once the messages route has a pinnable (non-`Response`)
200 type. (Background: an earlier fix hardened this test against a vacuous `InferResponseType` pin.)

---

## 11. Frozen fill-count + ad capture

### 11.1 Frozen fill-count (so a backdrop is pre-filled and the last turn streams live)
- `fillConversation` (`store.ts:407-426`) currently fills the **whole** script and advances the
  cursor to the end. Add an optional limit: `fillConversation(id, limit?)` — fill only
  `script.slice(0, limit)`, advancing cursor per filled turn, so a later driven `recordSendTurn`
  streams turn `limit+1` live.
- Add `FrozenParams.fill` + parse `?fill=N` in `parseFrozenParams`
  (`apps/web/src/demo/frozen.ts:9-28`; guard NaN/negative, omit when absent). Pass it in
  `bootFrozenDemo` (`apps/web/src/demo/bootstrap.tsx:155`).
- The social-banner generator (`apps/web/src/components/native-assets/social-banner.tsx:71`) omits
  `fill` → default "fill all" → unchanged.
- Tests: `parseFrozenParams` with `fill` (`frozen.test.ts`); `fillConversation(id, limit)` cursor
  behavior.

### 11.2 The ad capture
- `demo-welcome` (`fixtures.ts:97-130`) is 2 turns: T1 "What is HushBox?" → feature-list answer;
  T2 "If it's encrypted, how can the AI still read my messages?" → encryption answer. Reuse verbatim
  (D-D removes its `modelName`s; add seeded `cost`).
- Rewrite `ads/2026-07-hq-tour/03-screen-capture/capture.ts`: point `APP_URL` (`:27`) at
  `http://localhost:5173/demo?frozen=1&convo=demo-welcome&fill=1&scroll=bottom`. Beats 1–4 (already
  trusted Playwright input) now drive a real frozen composer/picker: T1 is the backdrop; open picker;
  switch model; type T2; it streams live attributed to the selected model; beat 5 holds on the
  encryption badge **and** the now-real cost.
- **Ad-narrative note:** with D-C, the picker default becomes the strongest model (not Smart Model),
  so the ad's "switch" is strongest → (another model or Smart Model). Pick the pair as a creative
  choice.
- Servers must be up (`pnpm dev`; Vite :5173, API :8788). Capture needs the API for the live
  `/models` passthrough that populates the picker. (See §14.)
- Then downstream ad production (Remotion edit, music, export) continues — out of scope here.

---

## 12. Already-landed work (context — do NOT redo)

Landed earlier this thread (working tree, uncommitted):
- **Demo balance shape drift** fixed — `store.getBalance()` returns the current `GetBalanceResponse`
  shape (`purchased`/`free`/`allowance`), not the legacy `{balance, freeAllowanceCents}`.
- **Demo conversation-detail** returns `membership` + no embedded messages (matches the new wire).
- **New demo history route** — `store.getMessagesPage` + shim route for
  `GET /conversations/:id/messages`.
- **`store.contract.test.ts` hardened** — the `getBalance` pin was vacuous (bare-`Response` handlers
  make `InferResponseType` admit anything); now scoped to status 200 + a required sentinel key, with
  canaries for members/links that fire if those slices become pinnable.
- **`apps/api/src/app.ts`** — `adminExecutorId` moved to lazy init (`crypto.randomUUID()` at module
  scope crashed the Worker: "Disallowed operation... in global scope"). Verify this survives the
  concurrent session's admin-plane work.
- Demo suite green (111 tests); `static-take1.webm` archived in `03-screen-capture/`.

Known related latent issue (not in this plan): the API response-typing is vacuous because slice
handlers return bare `Response` (`respond200`/`respondDomainError`), which blinds `AppType` response
inference. Not required for this fix, but relevant if you extend contract tests.

---

## 13. Constraints & gates (every task)

- **TDD, mandatory** — failing test first, watch it fail, minimal green, refactor. No production
  code without a failing test.
- **95% line/branch/function coverage** per package; checked in CI.
- **Boundaries (lint + arch-enforced):** routes hold no logic; a slice reads only its own tables
  except through published barrels; conversations reading `content_items` is already sanctioned (it
  reads it like `messages`/`users`) — do **not** add a conversations→billing read (that's Option A).
  Single-writer-per-table holds.
- **Sensitive tasks** (settlement/money; arguably the default-model change) get a **3-lens audit
  panel** (correctness / security / conventions).
- **Public-share privacy** — cost/model/isSmartModel must NOT leak onto the unauthenticated share
  read; enforce with a regression test.
- **Durable naming** — final orthodox names, no `v2`/task-id suffixes; comments state durable facts.
- **Docs are read-only** unless granted; `.md` edits need permission. (This handoff doc was
  explicitly requested.)
- **No git commits** by anyone; leave the working tree for the human.
- **Money never mis-billed** — Option B changes only the display mirror (`content_items.cost`), never
  the debit (`usage_records`/ledger). Keep it that way.

---

## 14. Suggested task decomposition & waves (for subagent-driven execution)

Contracts/foundations first; then parallelize genuinely independent slices; serialize anything
sharing files. Marked ⚠️ = sensitive (audit panel).

**Wave 1 — server foundation (product fix write + read)**
- **T1 ⚠️ Settlement cost completion + `is_smart_model`** — `apps/api/src/slices/chat/**`
  (settlement.ts + stores/ports). §7.1. Includes the `Σ content == Σ usage` invariant test.
- **T2 History endpoint carries cost/model/isSmartModel (history-only view; share stays clean)** —
  `apps/api/src/slices/conversations/**`. §7.2. Depends on nothing in T1 at the code level (columns
  already exist), but its *acceptance* (cost is the completed total) is only fully realized once T1
  lands; can be built in parallel and validated together. Includes the public-share regression test.

**Wave 2 — shared + client (depends on Wave 1 wire)**
- **T3 Shared sub-cent cost formatter** — `packages/shared/**`. §7.4.
- **T4 Client stops nulling cost/model/isSmartModel** — `apps/web/src/hooks/chat/chat.ts` (+ verify
  render). §7.3. Depends on T2 (wire) + T3 (formatter).

**Wave 3 — product UX (independent frontend)**
- **T5 ⚠️-ish Default picker to strongest model** — `apps/web/src/stores/model.ts`,
  `apps/web/src/hooks/models/use-resolve-default-model.ts`. §9. Independent of T1–T4 files; can run
  parallel to Wave 2. Confirm scope first (§3).

**Wave 4 — demo mirror (depends on T2/T4 wire shape)**
- **T6 Demo: attribute to selected model + drop fixture model** — `apps/web/src/demo/**`. §10.1.
- **T7 Demo: carry cost/model through `getMessagesPage` + seed fixture cost** —
  `apps/web/src/demo/**`. §10.2–10.3. Shares files with T6 → serialize T6→T7.

**Wave 5 — capture (depends on T6/T7)**
- **T8 Frozen fill-count** — `apps/web/src/demo/{store,frozen,bootstrap}.ts`. §11.1. Shares
  `store.ts` with T6/T7 → serialize after them.
- **T9 Rewrite `capture.ts` + run capture** — `ads/2026-07-hq-tour/03-screen-capture/**`. §11.2.
  Needs the dev stack up.

Every task: implement (test-first) → audit (read the audit; sensitive → 3-lens panel) → fix→audit
(cap 3 cycles) → clean. Final Phase-4 pass: full unscoped `pnpm typecheck`, `pnpm lint`,
`pnpm test:api|web|shared`, `pnpm lint:duplication`, `pnpm lint:unused`.

---

## 15. Key file reference index

**Server — billing/cost/settlement**
- `packages/db/src/schema/usage-records.ts:14-60` — usage_records (billed truth, per generation)
- `packages/db/src/schema/content-items.ts:41-47` — content_items cost/model/isSmartModel columns
- `packages/db/src/schema/messages.ts` — no cost column; `batchId:33`
- `apps/api/src/slices/chat/domain/settlement.ts:462-494` (cost write `:481`), `922-954` (commit) — **D-A/D-B change site**
- `apps/api/src/slices/billing/domain/charge.ts:76` — the actual debit formula
- `apps/api/src/slices/workflows/engine/settlement.ts:121-192` — charge posting + anchor mapping (`:131-150`)
- `apps/api/src/slices/workflows/nodes/smart-model-execution.ts:29-47,177-180` — classifier charge
- `apps/api/src/slices/workflows/nodes/model-call-execution.ts:40-41,156-158` — agentic cost pre-summed
- `packages/shared/src/nano-usd.ts:15-95` — serialize/format money (no sub-cent formatter yet)

**Server — history endpoint (read)**
- `apps/api/src/slices/conversations/domain/content-item-view.ts:11-31` — slim shared view (do NOT widen)
- `apps/api/src/slices/conversations/domain/history.ts:15-93` — history schemas + `historyMessageView`
- `apps/api/src/slices/conversations/ports/stores.ts:94-102` — `ContentItemRow`
- `apps/api/src/slices/conversations/adapters/stores.ts:973-991` — `contentItemsByMessage` SELECT
- `apps/api/src/slices/conversations/routes.ts:968-985` — endpoint (no logic)
- `apps/api/src/slices/conversations/domain/shares.ts:680-698` — public share reuse (must stay clean)
- `apps/api/src/legacy/routes/message-shares.ts:111-115` — legacy strips model/cost/smart from shares

**Client**
- `apps/web/src/hooks/chat/chat.ts:66-73,100-116` — `HistoryContentItem` + `toContentItemResponse` (nulls the 3 fields) — **client change site**
- `apps/web/src/hooks/crypto/use-decrypted-messages.ts:57-121` — `sumCost`/`pickModelName`/`pickIsSmartModel`
- `apps/web/src/components/chat/message/message-item.tsx:314` — `<MessageCost>` gate
- `apps/web/src/components/chat/message/message-cost.tsx:13` — `formatCost`
- `apps/web/src/hooks/chat/use-authenticated-chat.ts:251,637` — comments confirming cost-from-persisted intent

**Client — default model (D-C)**
- `apps/web/src/stores/model.ts:21` — `DEFAULT_MODEL_ID = SMART_MODEL_ID` + the text subscriber guard
- `apps/web/src/hooks/models/use-resolve-default-model.ts` — default resolver (text = no-op today)
- `apps/web/src/hooks/models/models.ts:61-82,87-130` — `findStrongestAndValueTextModels` / `getAccessibleModelIds`

**Demo + capture**
- `apps/web/src/demo/mock-backend/store.ts` — `appendTurn:483-548` (attribution `:514-517,543`), `getMessagesPage:263-287`, `DemoMessagesPage:105-125`, `buildContentItem:862-901` (`cost:null` `:873`), `fillConversation:407-426`, `recordSendTurn:370-390`, `DEMO_GENERIC_REPLY:52-54`
- `apps/web/src/demo/mock-backend/fetch-shim.ts:177-195` — `resolveChatRun` (sent model `:192`)
- `apps/web/src/demo/mock-backend/fixtures.ts:45-52` (`DemoTurn`), `:94` (`DEMO_BOOT_ID`), `:97-130` (`demo-welcome`)
- `apps/web/src/demo/frozen.ts:9-28`, `apps/web/src/demo/bootstrap.tsx:153-167`
- `apps/web/src/components/native-assets/social-banner.tsx:71` — frozen URL generator (omits `fill`)
- `ads/2026-07-hq-tour/03-screen-capture/capture.ts` — capture script

---

## 16. Environment / how to run

- **Dev stack:** `pnpm dev` (Vite :5173, Wrangler API :8788, Postgres, Neon proxy, Redis, SRH,
  MinIO). Ports are in the git-ignored `.env.scripts` (`HB_VITE_PORT=5173`, `HB_API_PORT=8788`).
  **Note:** `docs/DEVELOPMENT.md` was corrected — earlier it said :8787; the API is **:8788**.
- **Scoped test/lint per package** (SDD table): `apps/api/**` → `pnpm test:api` +
  `turbo typecheck lint --filter=@hushbox/api`; `apps/web/**` → `pnpm test:web` +
  `--filter=@hushbox/web`; `packages/shared/**` → `pnpm test:shared` + `--filter=@hushbox/shared`;
  `packages/db/**` → `pnpm test:db`.
- **Demo/capture gotcha:** the API worker crashes at boot if any module-scope code calls
  `crypto.randomUUID()`/`fetch`/timers ("Disallowed operation... in global scope") — keep such
  calls lazy. The `/demo` picker needs the API's live `/models` passthrough, so both Vite and the
  API must be up for the capture.
- **Running the capture:** `node_modules/.bin/tsx ads/2026-07-hq-tour/03-screen-capture/capture.ts demo 1`
  (from repo root). Playwright uses the repo's chromium; the MCP browser lacks Chrome. Frozen mode
  makes trusted `page.keyboard.type`/mouse work (live mode blocks them by design).

---

*End of handoff. Open decisions in §3 should be confirmed with the founder before or at the start of
execution. The product fix (§7) is a self-contained improvement worth shipping on its own branch; the
demo/ad work (§10–§11) depends on its wire shape.*
