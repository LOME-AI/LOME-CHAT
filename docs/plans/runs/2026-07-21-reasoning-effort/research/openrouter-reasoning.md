# OpenRouter reasoning/thinking-effort — research findings

Date: 2026-07-21. Installed packages verified in this repo: `ai@6.0.203` (AI SDK **v6**,
LanguageModelV3 spec — not v5) and `@openrouter/ai-sdk-provider@2.10.0`
(`node_modules/.pnpm/@openrouter+ai-sdk-provider@2.10.0_ai@6.0.203_zod@4.4.3__zod@4.4.3/`).
Live-API claims were verified against the public `GET https://openrouter.ai/api/v1/models`
(342 models) and `GET /api/v1/models/{id}/endpoints` on 2026-07-21. Docs source:
https://openrouter.ai/docs/use-cases/reasoning-tokens (also served at
/docs/best-practices/reasoning-tokens and /docs/guides/best-practices/reasoning-tokens).

Every claim is tagged **Verified** (observed this session: package source, live API, or the
fetched doc page), **Inferred**, or **Assumed**.

---

## 1. The `reasoning` request parameter

### Schema (Verified — OpenRouter docs page, and matching provider types)

```jsonc
"reasoning": {
  // one of effort | max_tokens (not both):
  "effort": "max" | "xhigh" | "high" | "medium" | "low" | "minimal" | "none",
  "max_tokens": 2000,          // exact token budget (Anthropic-style)
  "enabled": true,             // default inferred from effort/max_tokens presence;
                               // enabled:true alone => reasoning at "medium" effort
  "exclude": false,            // true = model still reasons, but reasoning not returned
  // OpenAI GPT-5.6+ only:
  "context": "auto" | "all_turns" | "current_turn",
  "mode": "standard" | "pro"   // pro bills same per-token rate but consumes more tokens
}
```

- The installed provider's type is narrower (Verified —
  `dist/index.d.ts:388-397`): `reasoning?: { enabled?; exclude?; } & ({ max_tokens: number }
  | { effort: 'xhigh'|'high'|'medium'|'low'|'minimal'|'none' })`. Note the provider type
  does **not** include `'max'`, `context`, or `mode` even though the HTTP API accepts them
  (Verified vs. docs + live `supported_efforts` containing `"max"`); passing them would
  need `extraBody` or a type assertion.
- Legacy `include_reasoning: true` ≡ `reasoning: {}`; `include_reasoning: false` ≡
  `reasoning: { exclude: true }` (Verified — docs). The provider still carries a
  `@deprecated includeReasoning` setting (Verified — `index.d.ts:404`).
- The old flat `reasoning_effort` top-level param is being phased out; **sending both
  `reasoning` and `reasoning_effort` is a 400**: `Only one of "reasoning" and
  "reasoning_effort" may be provided` (Verified — openclaw/openclaw#24119 and search
  summary of docs). 84/342 models still list `reasoning_effort` in
  `supported_parameters` (Verified — live /models).
- Default when nothing is sent: reasoning tokens are returned by default "if the model
  decides to output them" in the message's `reasoning` field; models with
  `reasoning.default_enabled: true` reason by default at `default_effort` (Verified —
  docs + live catalog fields, §3).

### Effort → budget normalization (Verified — docs)

For models that only support token budgets, effort converts as a fraction of
`max_tokens`: `max` ≈ 95%, `xhigh` ≈ 95%, `high` ≈ 80%, `medium` ≈ 50%, `low` ≈ 20%,
`minimal` ≈ 10%, `none` = reasoning disabled. The reverse also applies: for
effort-only models, a supplied `reasoning.max_tokens` "will be used to determine the
effort level" (Verified — docs; the exact reverse thresholds are undocumented —
Assumed nearest-bucket).

### Per-provider semantics

- **OpenAI o-series / GPT-5.x, Grok (xAI)** — native `effort`. o-series does not return
  reasoning content (only billed reasoning tokens); GPT-5.x returns
  `reasoning.summary` / `reasoning.encrypted` details (Verified — docs; formats enum
  `openai-responses-v1`, `xai-responses-v1` in provider `ReasoningFormat`,
  `index.d.ts:508-515`).
- **Anthropic** — native budget (`budget_tokens`). `reasoning.max_tokens` used directly,
  min 1024. With `effort`: `budget_tokens = max(min(max_tokens * effort_ratio, 128000),
  1024)` (older docs said cap 32000; current page says 128000 — Verified via fetch;
  treat the cap as provider-side and subject to change). Request `max_tokens` **must be
  strictly higher than the reasoning budget**. The `:thinking` model-suffix variant is
  retired in favor of `reasoning`. OpenRouter defaults Anthropic to summarized thinking
  display (`'summarized'` | `'omitted'`); billing follows tokens actually generated, so
  visible text can undercount `usage` (all Verified — docs).
- **Google Gemini** — thinking models accept `max_tokens` → passed as `thinkingBudget`,
  but Google converts it internally to a level, so no precise token control. Gemini 3+
  uses `thinkingLevel`; effort maps directly (`xhigh` mapped down to `high`); unsupported
  efforts map to nearest supported level (Verified — docs). Live catalog confirms Gemini
  3.x models expose `supported_efforts: [high, medium, low, minimal]`, many with
  `mandatory: true` (cannot turn reasoning off) (Verified — live /models).
- **DeepSeek (R1 family)** — always-on reasoner (`mandatory: true`, no
  `supported_efforts` in live catalog — Verified); returns raw chain-of-thought in the
  `reasoning` delta field. Provider code has an explicit carve-out: an **empty
  `reasoning_details: []` array is intentional** — it signals the provider produced no
  reasoning tokens this turn "(e.g. DeepSeek V4)" (Verified — provider `index.js` comment
  in the stream `reasoning-end` path).
- **Qwen/Alibaba** — some thinking models map `max_tokens` → `thinking_budget`; support
  varies per model (Verified — docs).

---

## 2. Interaction with `max_tokens` (priority)

- **Reasoning tokens are output tokens** and count against the completion budget. For
  budget-derived providers (Anthropic), the thinking budget is carved out of
  `max_tokens` by the effort ratio and `max_tokens` must strictly exceed it (Verified —
  docs). For OpenAI-style models, reasoning tokens also consume the completion budget
  (`completion_tokens_details.reasoning_tokens` is a subset of `completion_tokens` —
  Verified from provider usage mapping, `index.js:2599-2610`, which computes
  `text = completionTokens - reasoningTokens`).
- **Pitfall (real-world verified):** high effort + low `max_tokens` can consume the
  entire budget in thinking, leaving an **empty or truncated `content`** (documented in
  the wild at `max_tokens: 4096`; general guidance: ≥16k `max_tokens` for thinking
  modes). With Anthropic + `effort: high` (0.8 ratio), only ~20% of `max_tokens`
  remains for the answer. (Verified — search results incl. NousResearch/hermes-agent
  and community reports; the 16k guidance is community, not OpenRouter-official —
  Inferred.)
- **`max_tokens` unset:** the docs' effort formula is defined in terms of `max_tokens`
  but never states what is used when it is absent. Inferred: OpenRouter falls back to
  the endpoint's `max_completion_tokens` (the model's max output) as the basis —
  consistent with the separate verified budget-reservation behavior where an unset
  `max_tokens` reserves the model's full output capacity (e.g. 64k for Claude Sonnet
  4.5) against credit/budget checks (Verified that reservation behavior exists —
  timetobuildbob.com blog; the effort-basis fallback itself is **Inferred, needs an
  empirical probe** if the implementation depends on it). Safe design: always send an
  explicit `max_tokens` when sending `reasoning`, or use `reasoning.max_tokens`
  directly for precise control.
- **Anthropic minimum:** `reasoning.max_tokens < 1024` is raised to 1024 (Verified —
  docs). A `max_tokens` ≤ 1024 with any effort therefore risks rejection or a
  zero-answer window (Inferred).
- **HushBox admission-estimate implication (Inferred):** since reasoning bills as
  output, the canonical estimator's output-token ceiling already prices it as long as
  the assumed output ceiling ≥ `max_tokens` actually sent; enabling high effort raises
  *realized* cost toward the ceiling, not past it.

---

## 3. Discoverability (`/models` API)

All Verified against the live public `GET /api/v1/models` (2026-07-21, 342 models):

- `supported_parameters` (per model, and per endpoint on
  `GET /api/v1/models/{author}/{slug}/endpoints`) includes `reasoning` (210/342),
  `include_reasoning` (210/342 — always paired), and legacy `reasoning_effort`
  (84/342). Presence of `reasoning` = the model accepts the unified parameter.
- A **top-level `reasoning` object** exists on 211/342 models with fields:
  - `mandatory` (211/211): `true` = reasoning cannot be disabled (`effort:"none"`
    rejected) — e.g. `openai/gpt-5`, `deepseek/deepseek-r1-0528`, `x-ai/grok-4.5`,
    most Gemini 3.x.
  - `supported_efforts` (81/211): descending list, e.g. gpt-5.2 →
    `[xhigh, high, medium, low, none]`, gpt-5 → `[high, medium, low, minimal]`,
    grok-4.5 → `[high, medium, low]`, kimi-k3 → `[max, high, low]`. Docs: `null` =
    all efforts accepted; **field omitted = no effort selection** (budget-or-nothing
    models).
  - `default_effort` (81/211): the effort used when reasoning is on but unspecified.
    `default_effort: "none"` means off-by-default, not a selectable "none".
  - `default_enabled` (72/211): reasons by default without any `reasoning` param.
  - `supports_max_tokens` (7/342 only — e.g. `meituan/longcat-2.0`,
    `nvidia/nemotron-3-nano-...`): explicit flag that `reasoning.max_tokens` is
    honored. **Sparse — cannot be the sole budget-support signal.**
- **Effort-less budget models exist and are common:** Anthropic (`claude-sonnet-4.5`),
  Gemini 2.5, DeepSeek R1 all expose `reasoning: { mandatory: ... }` with **no
  `supported_efforts`** — they take `max_tokens` (or nothing), and OpenRouter's
  server-side effort→ratio normalization is what makes a client-sent `effort` still
  work on them. The inverse (effort-only, e.g. OpenAI o-series) also exists; a
  client-sent `reasoning.max_tokens` is converted to an effort level by OpenRouter.
  So **a client may always send either form**; `supported_efforts` tells you when the
  levels are native/enumerable vs. ratio-approximated.
- Recommended client mapping (Inferred, from the above): if `supported_efforts`
  present → offer exactly those levels; else if model has a `reasoning` object → offer
  a generic low/medium/high mapped through OpenRouter's ratio normalization (or send
  `max_tokens` budgets directly); `mandatory: true` → hide the "off" option;
  `default_enabled`/`default_effort` → preselect UI state.
- The per-endpoint listing carries `supported_parameters` per provider endpoint
  (Verified — `/models/anthropic/claude-sonnet-4.5/endpoints`: Bedrock, Anthropic,
  Google, Azure all list `reasoning`), but the rich `reasoning` discovery object is
  **model-level only** — no per-endpoint effort variation is exposed (Verified — no
  reasoning-related keys on endpoint objects).
- HushBox note: the catalog slice already snapshots `/models` hourly; these fields ride
  the same response, so discovery is a snapshot-schema addition, not a new fetch
  (Verified — ARCHITECTURE.md catalog description; Inferred that the current snapshot
  drops these fields — confirm in `apps/api` catalog code during planning).

---

## 4. Streaming — wire format and AI SDK v6 surface

### OpenRouter wire (Verified — docs + provider stream parser)

Streaming chunks carry `choices[].delta.reasoning` (plain text CoT) and/or
`choices[].delta.reasoning_details` (typed array). Non-streaming:
`choices[].message.reasoning` / `.reasoning_details`. `reasoning_details` union
(Verified — provider Zod schemas, `index.d.ts:517-543`):

- `{ type: "reasoning.text", text?, signature?, id?, format?, index? }`
- `{ type: "reasoning.summary", summary, id?, format?, index? }`
- `{ type: "reasoning.encrypted", data, id?, format?, index? }` (streams may show
  `[REDACTED]` data)

`format` ∈ `unknown | openai-responses-v1 | azure-openai-responses-v1 |
xai-responses-v1 | anthropic-claude-v1 | google-gemini-v1` (provider enum;
docs additionally list `meta-responses-v1` — the installed enum lacks it, Verified).

### Installed provider behavior (`@openrouter/ai-sdk-provider@2.10.0`, Verified — `dist/index.js`)

- Emits LanguageModelV3 stream parts: one `reasoning-start` (generated id), then
  `reasoning-delta` per chunk, then `reasoning-end` **when the first text/content delta
  arrives**. Text chunks come from `delta.reasoning_details` (`reasoning.text` → text;
  `reasoning.summary` → summary text; `reasoning.encrypted` → **skipped**, no delta) or,
  if no details present, from the plain `delta.reasoning` string. Reasoning arriving
  *after* text has started is not re-emitted as reasoning deltas (`!textStarted` guard).
- Accumulates and de-duplicates `reasoning_details` (consecutive `reasoning.text`
  merged; signature/format backfilled) and attaches the full array to
  `providerMetadata.openrouter.reasoning_details` on `reasoning-end` (and on
  `doGenerate` results; if reasoning is attached to a tool call it rides that part
  instead — `reasoningDetailsAttachedToToolCall`).
- `providerMetadata.openrouter.usage` carries `completionTokensDetails.reasoningTokens`,
  `cost`, `costDetails.upstreamInferenceCost` when `usage: { include: true }` accounting
  is on (Verified — types `index.d.ts:449-470` and usage mapping; HushBox already
  enables accounting via `compatibility: 'strict'` +
  `apps/api/src/slices/models/adapters/openrouter-provider.ts`).

### Passing options (Verified — provider source)

Two equivalent paths, both landing on the request body:
1. Model settings: `provider.chat(modelId, { reasoning: { effort: 'high' } })` —
   `getArgs` puts `reasoning: this.settings.reasoning` in the body (`index.js` args
   builder). HushBox's `language-adapter.ts:414` already uses
   `provider.chat(request.model, languageRoutingOptions())`, so this is the natural
   insertion point.
2. Call-level `providerOptions: { openrouter: { reasoning: ... } }` on
   `streamText`/`generateText` — `doGenerate`/`doStream` spread
   `providerOptions.openrouter` **over** the args (`index.js:3628-3631`), so
   call-level wins over model settings.

### AI SDK v6 (`ai@6.0.203`, Verified — `dist/index.d.ts`)

- `streamText().fullStream` exposes `reasoning-start` / `reasoning-delta` /
  `reasoning-end` parts (typed at d.ts:2036-2045 etc.); HushBox's adapter already
  tracks `reasoningIds` in its `StreamState` (Verified —
  `apps/api/src/slices/models/adapters/language-adapter.ts:439`).
- `toUIMessageStreamResponse({ sendReasoning })` — **defaults to `true`** in v6
  (Verified — d.ts:2299 "Default to true."; in AI SDK v5 the default was false —
  Assumed, irrelevant here). HushBox does not use UIMessage streams (custom WS
  protocol), so reasoning forwarding to clients is HushBox's own protocol decision.
- `usage.outputTokenDetails.reasoningTokens` and `cachedInputTokens` are first-class in
  v6 `LanguageModelUsage` (Verified — adapter `mapUsage`,
  `language-adapter.ts:135-140`).

---

## 5. Billing

- "Reasoning tokens are considered output tokens and charged accordingly" (Verified —
  docs). They are counted inside `completion_tokens`
  (`completion_tokens_details.reasoning_tokens` is the breakdown — Verified, provider
  usage schema).
- The authoritative inline `usage.cost` (usage accounting) **includes** reasoning-token
  cost — it is the total charged amount for the request; no separate reasoning line
  item exists (Verified for the field being total billing truth — docs/usage-accounting
  + HushBox's settled billing design; Inferred that no separate reasoning cost field
  exists — none appears in the provider schemas or docs).
- Anthropic summarized thinking: billed per tokens *generated*, which can exceed the
  visible summary (Verified — docs). `exclude: true` does **not** avoid the charge —
  the model still reasons (Verified — docs semantics of exclude).
- Effort level directly scales realized output cost (more reasoning tokens at same
  per-token price); OpenAI `mode: "pro"` bills the same rate but typically consumes
  more tokens (Verified — docs).

## 6. Multi-turn preservation (`reasoning_details` passthrough)

- Docs: pass reasoning back either as `message.reasoning` (plain string, alias
  `reasoning_content`) or as `message.reasoning_details` (required for
  encrypted/summarized types). Blocks must be passed back **unmodified and in order**.
  Matters most for **tool-calling continuity** (model resumes after tool results) and
  for Anthropic/Gemini signed thinking (Verified — docs).
- The installed provider automates this: assistant history messages get
  `reasoning_details` from (a) that message's
  `providerOptions.openrouter.reasoning_details`, else (b) reasoning parts' metadata in
  the message content; it then **filters out `anthropic-claude-v1` / `google-gemini-v1`
  `reasoning.text` entries lacking a `signature`** (console-warning when it drops any)
  before sending (Verified — `index.js:3053-3090`).
- **For HushBox (Inferred):** the app replays history as plain decrypted text
  (`toHistoryMessages`) without reasoning parts, so nothing is passed back today. For a
  plain chat turn this is legitimate — providers treat prior reasoning as optional
  context. It becomes load-bearing only (a) mid-run across tool-call steps — the SDK
  handles that inside one `streamText` call automatically — or (b) if HushBox ever
  wants cross-turn reasoning continuity, which would require persisting
  `reasoning_details` (including encrypted blobs) in the encrypted content items.
  Not required for correctness of a reasoning-effort feature.

## 7. Other load-bearing facts

- **ZDR:** `reasoning` is orthogonal to `provider.zdr` — it's a body param, ZDR is
  endpoint routing; no documented interaction (Verified absence — docs). Encrypted
  reasoning (`reasoning.encrypted`) is OpenAI's stateless-reasoning mechanism and works
  under ZDR since nothing is retained server-side (Inferred). Note OpenAI o-series
  returns no reasoning content at all — a reasoning-display feature will show nothing
  for those models while still billing reasoning tokens (Verified — docs).
- **Tool calls:** reasoning_details are attached to the tool-call part when reasoning
  precedes a tool invocation (provider behavior, Verified); preserving them across the
  tool loop is handled by the SDK within a single multi-step call.
- **`exclude: true`** hides reasoning from the response but does not disable or
  discount it; `effort: "none"` (where allowed, i.e. `mandatory: false`) disables it
  (Verified — docs + live `mandatory` field).
- **Known bugs / gotchas:**
  - Sending both `reasoning` and legacy `reasoning_effort` → HTTP 400 (Verified —
    openclaw#24119). The installed provider never sends `reasoning_effort`, so this
    only matters if `extraBody` is misused.
  - Provider strips unsigned Anthropic/Gemini `reasoning.text` history entries with a
    raw `console.warn` (gated on `globalThis.AI_SDK_LOG_WARNINGS`) — relevant to
    HushBox's no-console telemetry rule if reasoning history is ever passed back
    (Verified — provider source).
  - Truncated/empty answers when effort-derived budget ≈ `max_tokens` (§2).
  - The provider's `reasoning` TS type omits `max`/`none`... no: it **includes**
    `none` and `minimal` but omits `max` (and `context`/`mode`) — use `extraBody` for
    those (Verified — `index.d.ts:395`).
  - `~latest` alias models (e.g. `~openai/gpt-latest`) carry their own
    `supported_efforts` incl. `max`/`xhigh` (Verified — live /models).

### Primary sources

- https://openrouter.ai/docs/use-cases/reasoning-tokens (reasoning parameter reference)
- https://openrouter.ai/api/v1/models and /api/v1/models/{id}/endpoints (live, 2026-07-21)
- Installed source: `node_modules/.pnpm/@openrouter+ai-sdk-provider@2.10.0_.../dist/index.{d.ts,js}`,
  `node_modules/.pnpm/ai@6.0.203_zod@4.4.3/node_modules/ai/dist/index.d.ts`
- https://github.com/openclaw/openclaw/issues/24119 (reasoning + reasoning_effort 400)
- https://timetobuildbob.com/blog/the-hidden-cost-of-max_tokens-openrouter-budget-trap/
  (unset max_tokens reserves full output capacity)
- HushBox call sites: `apps/api/src/slices/models/adapters/language-adapter.ts`,
  `apps/api/src/slices/models/adapters/openrouter-provider.ts`

---

# Round 2 — deeper pass (2026-07-21)

Empirical-probe status: **no usable key**. The only local credential is
`apps/api/.dev.vars: OPENROUTER_API_KEY="mock-openrouter-key"` (Verified); real keys are
CI/production secrets this agent must not touch. A keyless probe of
`POST /api/v1/chat/completions` returns `401 "No cookie auth credentials found"` before
any body validation (Verified — live curl), so request-validation behavior could not be
tested empirically. Items below that needed a live call are marked Inferred and listed
as recommended probes for whoever holds a dev key.

## A. Can `effort` and token limits coexist? (priority)

### (a) `reasoning.effort` + completion `max_tokens` — YES, and it is the intended pairing

This is the documented normal case (Verified — reasoning-tokens doc). Semantics per
family:

- **Effort-native (OpenAI o-series/GPT-5.x, Grok, gpt-oss, Gemini 3 thinkingLevel):**
  `effort` passes through (nearest supported level if the exact one isn't offered —
  "if a model only supports low and high, OpenRouter maps your requested effort to the
  nearest supported level", Verified — doc); `max_tokens` remains the ordinary
  completion cap. Reasoning tokens still spend from the completion budget
  (`reasoning_tokens ⊆ completion_tokens`, Verified — provider usage schema), so a small
  `max_tokens` with high effort can exhaust itself in thinking (finish_reason `length`,
  empty content — Verified in the wild, round 1 §2).
- **Budget-native (Anthropic; Gemini ≤2.5 thinkingBudget; Qwen thinking_budget;
  DeepSeek has no budget knob at all):** OpenRouter *derives* the provider budget from
  the pair: `budget = max(min(max_tokens × ratio, 128000), 1024)` with ratios
  max/xhigh 0.95, high 0.8, medium 0.5, low 0.2, minimal 0.1 (Verified — doc). The
  request's `max_tokens` must strictly exceed the derived budget (Verified — doc). For
  DeepSeek-class always-on reasoners with no budget parameter, effort has no
  documented effect beyond enabled/excluded (Inferred — no mapping is documented and
  the live catalog shows no `supported_efforts` for them).
- **Precedence:** there is none to resolve — the two live at different levels;
  OpenRouter never rewrites completion `max_tokens` from effort, only derives the
  *reasoning* budget from it (Verified — doc describes only budget derivation).

### (b) `reasoning.effort` + `reasoning.max_tokens` both set — treat as invalid; do not send

- The docs' schema comment is explicit: "One of the following (**not both**)"
  (Verified — doc). One newer passage says clients "can send `reasoning.max_tokens`
  instead of (**or alongside**) `reasoning.effort`" (Verified — same doc, discovery
  section), so the page itself is internally inconsistent.
- Third-party documentation states sending both returns an **error**; no precedence
  rule is documented anywhere (Verified that these secondary sources say so —
  glarity/deepwiki summaries; the actual HTTP behavior is **unverified — Inferred:
  400 or undefined**; needs a live probe).
- The installed provider makes the combination **unrepresentable in TypeScript**
  (`{max_tokens} | {effort}` union, Verified — `index.d.ts:388-397`), though nothing
  strips it at runtime if forced through `extraBody`/casts (Verified — args builder
  passes `settings.reasoning` through untouched).
- **Implementation rule:** model the pair as a discriminated union end-to-end; never
  emit both. (The related-but-different verified 400 is nested `reasoning` + legacy
  top-level `reasoning_effort`, openclaw#24119.)

### (c) `reasoning.max_tokens` + completion `max_tokens` — YES; one hard constraint

Fully supported and the precise-control path. Anthropic: `reasoning.max_tokens` used
directly, floor 1024, cap 128000; completion `max_tokens` **must be strictly greater**
than the reasoning budget or the request is invalid (Verified — doc; whether OpenRouter
clamps vs. forwards Anthropic's own 400 is undocumented — Inferred: passed through,
since only the floor/cap clamps are documented). Gemini: forwarded as `thinkingBudget`
but Google re-quantizes to a level — no precise control (Verified — doc). Effort-only
models: the budget is converted to a nearest effort level (Verified — doc; thresholds
undocumented). Models with neither knob: routing default applies — the parameter is
silently ignored (see §C routing).

## B. Unknown-unknowns resolved

- **`max_tokens` unset + effort (round-1 open item):** still not documented anywhere;
  no formula basis is stated for an absent `max_tokens` (Verified absence — full doc
  fetch asking exactly this). Two adjacent verified facts: (1) unset `max_tokens`
  causes OpenRouter to reserve the endpoint's full output capacity for credit checks;
  (2) routing only filters on `max_tokens` when it is set. **Inferred:** the effort→
  budget math falls back to the endpoint's `max_completion_tokens`. **Design rule
  stands: always send an explicit completion `max_tokens` alongside `reasoning`.**
  (Top remaining empirical probe.)
- **`mandatory: true` + `effort:"none"`:** the doc is explicit — "When `true`, hide
  disable controls and do not send `effort: 'none'` — the model **rejects** it"
  (Verified — doc). `enabled: false` on a mandatory model is not separately
  documented (Inferred: same rejection or silent ignore; avoid sending it — UI should
  hide the off switch when `mandatory`).
- **Sending nothing at all:** the model's own defaults apply — `default_enabled: true`
  models reason at `default_effort` with no `reasoning` param sent;
  `default_effort: "none"` means off-by-default (Verified — doc + live catalog).
  OpenRouter does not inject a reasoning param on its own (Inferred from doc framing
  of these fields as model defaults / client-UI guidance).
- **`supported_efforts` absent on a reasoning-capable model** means "no effort
  *selection*" (budget-style model), **not** "effort rejected": OpenRouter's
  effort→ratio normalization is exactly how effort still works there (Verified — doc:
  omitted = no effort selection + the budget-model conversion section). `null` (as
  distinct from omitted) = all efforts accepted (Verified — doc). Nearest-level
  remapping handles partial lists (Verified — doc).
- **Floors:** Anthropic 1024 floor is applied by OpenRouter's own clamp (`max(…, 1024)`)
  — a derived budget below 1024 is raised, not rejected (Verified — doc formula).
  Gemini floors (e.g. 2.5 Pro's undisableable thinking, per-model thinkingBudget
  minima) are **not** documented on OpenRouter's side; Google re-quantizes whatever
  budget arrives (Verified absence + doc's "no precise token control"). Live catalog
  encodes undisableable Gemini as `mandatory: true` (Verified).
- **GPT-5 `verbosity`:** a separate top-level OpenRouter param (announced Aug 2025,
  OpenRouter on X), orthogonal to `reasoning` — controls answer length, not thinking.
  In today's live catalog `verbosity` appears in `supported_parameters` on **12
  Anthropic models only** (claude-sonnet-5, fable/opus 4.5–4.8 families) — not on any
  GPT-5.x row (Verified — live /models 2026-07-21); community reports OpenRouter's
  verbosity support flags for OpenAI models are inaccurate (big-AGI#948/#927). Treat
  verbosity as out of scope for a reasoning-effort feature; if ever offered, gate it
  on `supported_parameters` per model.
- **Per-endpoint variance + fallback routing (load-bearing):** by default, "providers
  that don't support all the [LLM parameters] specified in your request can still
  receive the request, but will **ignore** unknown parameters" — i.e. `reasoning`
  can be **silently dropped** by an endpoint that doesn't implement it. Setting
  provider routing `require_parameters: true` restricts routing to endpoints
  supporting every sent parameter (Verified — provider-routing doc). HushBox today
  pins `{ zdr: true, data_collection: 'deny', allow_fallbacks: false }` and does
  **not** set `require_parameters` (Verified —
  `packages/shared/src/models/routing-options.ts:47-49`). With `allow_fallbacks:
  false` the primary-endpoint choice is deterministic, but the chosen endpoint
  ignoring `reasoning` remains possible in principle; per-endpoint
  `supported_parameters` (Verified available — /endpoints API) or
  `require_parameters: true` are the guards. Decide explicitly in the plan; note
  `require_parameters: true` + ZDR narrows the endpoint pool and can surface
  "no endpoints found" errors (Inferred).
- **Interleaved reasoning + tool calls:** OpenRouter's multi-turn rules require
  passing back the *entire consecutive sequence* of reasoning blocks unmodified —
  supporting multiple reasoning blocks interleaved with tool calls in one response
  (Verified — doc: "the entire sequence of consecutive reasoning blocks must match
  the outputs generated by the model"). The installed provider accumulates all
  details per response and attaches them to the tool-call part when reasoning
  precedes one (Verified — provider source, round 1 §4); within a single multi-step
  `streamText` the SDK replays them automatically.
- **`exclude: true` in streaming:** documented only as "reasoning will be removed
  from the response" — with `exclude`, no `reasoning`/`reasoning_details` deltas
  arrive, so the provider emits no reasoning stream parts (the model still reasons
  and bills; time-to-first-token stays reasoning-bound) (Verified for semantics —
  doc; stream-shape consequence Inferred from provider code, which only emits
  reasoning parts when deltas carry reasoning).
- **Empty-reasoning models (o-series) detection:** no catalog flag distinguishes
  "reasons but returns nothing" (o-series) from summary/text-returning models
  (Verified absence — live /models field census, round 1 §3). Detection is
  behavioral: `usage.completion_tokens_details.reasoning_tokens > 0` with zero
  reasoning stream parts. UI must tolerate billed-but-invisible reasoning
  (Verified — docs note o-series does not return reasoning tokens).
- **Changelog/bugs 2025–2026:** no dated OpenRouter changelog entry for
  `supported_efforts`/`default_effort`/`xhigh` was findable via search — the live
  docs are the only authority (Verified absence — targeted search). Known issue
  cluster in the wild: clients sending both nested `reasoning` and flat
  `reasoning_effort` → 400 (openclaw#24119); `xhigh` originates from OpenAI
  Codex-max models (Verified — OpenAI Codex config docs via search). The doc's
  Anthropic cap changed 32000 → 128000 at some point in 2025/26 (Verified — both
  values observed in current vs. cached doc copies): treat any hardcoded cap as
  volatile; don't encode it client-side.

## C. Recommended empirical probes (needs a real dev key; ~6 calls, <$0.05)

1. `effort` + `reasoning.max_tokens` both set → expect 400 (confirm (b)).
2. `effort: "high"` with `max_tokens` unset on `anthropic/claude-*` → inspect
   `reasoning_tokens` to infer the derivation basis (resolves B-1).
3. `reasoning.max_tokens: 512` (below floor) on Anthropic → confirm clamp-to-1024 vs 400.
4. Completion `max_tokens: 1500` + `reasoning.max_tokens: 1400` → confirm
   strictly-greater enforcement point (OpenRouter vs provider 400).
5. `effort: "none"` and `enabled: false` on a `mandatory: true` model (deepseek-r1) →
   rejection vs silent ignore.
6. `effort: "medium"` on deepseek-r1 (budget-less reasoner) → confirm no-op semantics.

### Round-2 additional sources

- https://openrouter.ai/docs/guides/best-practices/reasoning-tokens (current canonical path)
- https://openrouter.ai/docs/features/provider-routing (`require_parameters`, ignore-unknown-params default, ZDR OR-semantics)
- https://github.com/openclaw/openclaw/issues/24119 · https://github.com/enricoros/big-AGI/issues/948
- https://x.com/OpenRouterAI/status/1954670279332110517 (verbosity announcement)
- Live: `POST /api/v1/chat/completions` keyless 401 probe; `/api/v1/models` verbosity census (2026-07-21)
- Repo: `packages/shared/src/models/routing-options.ts`, `apps/api/.dev.vars`
