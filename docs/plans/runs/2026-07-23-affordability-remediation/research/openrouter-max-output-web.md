# OpenRouter max-output / completion-token metadata (as of 2026-07-23)

Sources consulted: OpenRouter's public OpenAPI spec (`https://openrouter.ai/openapi.json`,
downloaded 2026-07-23, 1.65 MB) and the current docs site (Mintlify-rendered; markdown
source fetched via each page's `.md` suffix, which returns the pre-render source rather
than the client-rendered HTML). All claims below are Verified against these two sources
unless marked otherwise.

---

## 1. `GET /api/v1/models` response schema

Doc page: https://openrouter.ai/docs/guides/overview/models (fetched as
`https://openrouter.ai/docs/guides/overview/models.md`)
OpenAPI schema: `components.schemas.Model` and `components.schemas.TopProviderInfo` /
`PerRequestLimits` in `https://openrouter.ai/openapi.json`

**Verified — `top_provider` object exists and carries `max_completion_tokens`:**

```typescript
// "Top Provider Object" (docs/guides/overview/models.md)
{
  "context_length": number,        // Provider-specific context limit
  "max_completion_tokens": number, // Maximum tokens in response
  "is_moderated": boolean          // Whether content moderation is applied
}
```

The OpenAPI spec's `TopProviderInfo` schema (authoritative for nullability, since the
narrative docs page's TypeScript block omits `| null`):

```json
"TopProviderInfo": {
  "properties": {
    "context_length": {
      "description": "Context length from the top provider",
      "type": ["integer", "null"],
      "nullable": true
    },
    "is_moderated": { "type": "boolean" },
    "max_completion_tokens": {
      "description": "Maximum completion tokens from the top provider",
      "type": ["integer", "null"],
      "nullable": true
    }
  },
  "required": ["is_moderated"]
}
```

- **Verified**: both `top_provider.context_length` and `top_provider.max_completion_tokens`
  are typed `integer | null` and are *not* in the schema's `required` array (only
  `is_moderated` is required) — i.e. both fields are optional/nullable.
- **Not verified**: neither the OpenAPI spec nor the narrative docs page states in prose
  what a `null` value semantically means (e.g. "provider imposes no separate output cap
  beyond context length" vs. "OpenRouter has no data for this provider"). This is an
  inference gap — see §4.
- The top-level `Model` schema (`GET /api/v1/models` → `data[]`) also carries its own
  top-level `context_length: integer | null`, separate from `top_provider.context_length`
  — the docs describe the top-level one as "Maximum context window size in tokens" and the
  nested one as "Provider-specific context limit," but in the shown example both equal
  8192 for `openai/gpt-4`, so the doc does not make the distinction concrete.

**Verified — `per_request_limits`:**

```json
"PerRequestLimits": {
  "description": "Per-request token limits",
  "example": { "completion_tokens": 1000, "prompt_tokens": 1000 },
  "properties": {
    "completion_tokens": { "type": "number" },
    "prompt_tokens": { "type": "number" }
  },
  "required": ["prompt_tokens", "completion_tokens"],
  "type": ["object", "null"]
}
```

The narrative docs table (`docs/guides/overview/models.md`) describes it only as: "Rate
limiting information (null if no limits)". The OpenAPI example for a full model object
(`openai/gpt-4`) shows `"per_request_limits": null`.

- **Verified**: `per_request_limits` is `object | null`; when non-null it has
  `prompt_tokens` and `completion_tokens` sub-fields (both `number`).
- **Not verified**: what, operationally, sets a non-null value (BYOK key limits? free-tier
  throttling?) — no doc prose explains when this is populated; both docs and every example
  payload seen show it `null`.

**Model object required fields** (from `components.schemas.Model.required`): `id`,
`canonical_slug`, `name`, `created`, `pricing`, `context_length`, `architecture`,
`top_provider`, `per_request_limits`, `supported_parameters`, `default_parameters`,
`supported_voices`, `links`. Note `top_provider` and `per_request_limits` are themselves
*required keys* on the model object — they always appear — but their **contents** can be
null per the nested schemas above.

---

## 2. `GET /api/v1/models/{author}/{slug}/endpoints` response schema

OpenAPI path: `/models/{author}/{slug}/endpoints`, schema `ListEndpointsResponse` →
`endpoints[]: PublicEndpoint` (`https://openrouter.ai/openapi.json`).

**Verified — per-endpoint fields (`PublicEndpoint` schema):**

```json
{
  "context_length": { "type": "integer" },
  "max_completion_tokens": { "type": ["integer", "null"] },
  "max_prompt_tokens": { "type": ["integer", "null"] },
  "model_id": "string",
  "model_name": "string",
  "name": "string",
  "provider_name": { "$ref": "ProviderName" },
  "quantization": "Quantization | null",
  "status": { "$ref": "EndpointStatus" },
  "supported_parameters": ["Parameter"],
  "supports_implicit_caching": "boolean",
  "tag": "string",
  "uptime_last_5m/30m/1d": "number | null",
  "throughput_last_30m": "PercentileStats | null (auth-gated)",
  "latency_last_30m": "PercentileStats"
}
```

`required` array for `PublicEndpoint` includes both `max_completion_tokens` and
`max_prompt_tokens` — i.e. the **keys are always present** in each endpoint object, but
their **values are typed `integer | null`** (same nullable pattern as the models-list
endpoint's `top_provider` fields). No `nullable: true` marker or prose explanation is
attached to these two fields specifically in the OpenAPI spec (unlike `TopProviderInfo`,
which does carry `"nullable": true`); the type union `["integer", "null"]` is the only
signal.

- **Verified**: this confirms **per-provider variation** is real — each entry in
  `endpoints[]` (one per provider serving that model) carries its own
  `max_completion_tokens` / `max_prompt_tokens`, independent of the aggregate
  `top_provider.max_completion_tokens` on the `/models` list (which reflects only
  the *currently selected top/default* provider).
- No narrative prose page for this endpoint was found beyond the OpenAPI-generated
  reference (no separate guide under `docs/guides/`); the example payload
  (`openai/gpt-4` via `OpenAI` tag) shows non-null `4096` / `8192` values.
- **Not verified**: no documented statement of what null means here either (see §4).

---

## 3. Image and video models APIs — output-size metadata

OpenAPI paths verified: `/images/models`, `/images/models/{author}/{slug}/endpoints`,
`/videos/models` (`https://openrouter.ai/openapi.json`).

**Images (`ImageModelListItem` / `ImageEndpoint` schemas):** No `max_completion_tokens`,
`max_prompt_tokens`, or any token-count field exists anywhere in the image-model schemas.
Output-size metadata instead comes through `supported_parameters`, an enum/range/boolean
map, e.g.:

```json
"supported_parameters": {
  "resolution": { "type": "enum", "values": ["1K", "2K", "4K"] },
  "seed": { "type": "boolean" }
}
```

Pricing for image endpoints is a list of billable line items (`ImagePricingEntry`, e.g.
`{"billable": "output_image", "cost_usd": 0.05, "unit": "image"}`), not a per-token price —
so there is no output-token cap concept for image models in the schema at all.

**Videos (`VideoModel` schema):** Likewise no token-count field. Output-size constraints
are expressed as enumerated/array fields: `supported_resolutions` (e.g. `480p`…`4K`),
`supported_aspect_ratios`, `supported_sizes` (width×height strings), `supported_durations`
(array of integer seconds), `supported_frame_images`, `generate_audio` (boolean|null),
`seed` (boolean|null). All of these are typed `array | null` — nullable when the model
doesn't support that dimension of configuration — but none is a token-count analog of
`max_completion_tokens`.

**Conclusion (Verified):** Neither the dedicated image-models API nor the video-models API
publishes any `max_completion_tokens`/`max_output_tokens`/token-based output-size field.
Output constraints for these modalities are expressed natively (resolution, duration,
aspect ratio, size) rather than in tokens, consistent with their non-token billing model
(`ImagePricingEntry` is cost-per-image/per-unit; video's `pricing_skus` is a
string-keyed map, also not token-priced).

---

## 4. Semantics: is `max_completion_tokens` a hard output cap? Does it include reasoning tokens? Documented gotchas?

**Hard cap — Verified**, from the request-parameter docs (distinct from the model-metadata
field of the same name), `https://openrouter.ai/docs/api_reference/parameters.md`:

> **Max Tokens** — Key: `max_tokens` — Optional, integer, 1 or above — "This sets the upper
> limit for the number of tokens the model can generate in response. It won't produce more
> than this limit. The maximum value is the context length minus the prompt length."
>
> **Max Completion Tokens** — Key: `max_completion_tokens` — Optional, integer, 1 or above —
> identical wording: "This sets the upper limit for the number of tokens the model can
> generate in response. It won't produce more than this limit. The maximum value is the
> context length minus the prompt length."

This is the *request parameter* semantics (client-supplied cap), not a direct statement
about the *metadata field* `top_provider.max_completion_tokens` / per-endpoint
`max_completion_tokens` returned by the models/endpoints APIs. The docs do not explicitly
connect the metadata field to "this is the maximum legal value you may pass as the
`max_tokens` request parameter for this provider," though that is the natural reading —
**this connection is Inferred, not stated verbatim anywhere fetched.**

**Reasoning tokens count as output tokens — Verified**, from
`https://openrouter.ai/docs/guides/best-practices/reasoning-tokens.md`:

> Line 55: "Reasoning tokens provide a transparent look into the reasoning steps taken by a
> model. Reasoning tokens are considered output tokens and charged accordingly."
>
> Line 947 (FAQ-style aside): "Reasoning tokens are counted as output tokens for billing
> purposes."
>
> Line 942 (Anthropic-specific budget guidance): "**Important**: `max_tokens` must be
> strictly higher than the reasoning budget to ensure there are tokens available for the
> final response after thinking."
>
> Lines 935–938 (Anthropic-specific): "When using the `reasoning.max_tokens` parameter,
> that value is used directly with a minimum of 1024 tokens... The reasoning token
> allocation is capped at 128,000 tokens maximum and 1024 tokens minimum. The formula for
> calculating the budget_tokens is: `budget_tokens = max(min(max_tokens * {effort_ratio},
> 128000), 1024)`" — i.e. for Anthropic models routed through OpenRouter, the reasoning
> budget is literally derived as a fraction of the same `max_tokens`/`max_completion_tokens`
> value, confirming reasoning and final-answer tokens share one pool bounded by that
> parameter.

**Conclusion (Verified via the above two docs, combined — Inferred as a general rule across
all providers):** reasoning tokens are billed as output tokens and, at least for Anthropic
models on OpenRouter, are drawn from the same `max_tokens`/`max_completion_tokens` budget
as the visible completion — the docs explicitly require `max_tokens` to exceed the
reasoning budget so completion tokens remain. Whether this "shared pool" behavior is
universal across all providers/models (vs. Anthropic-specific budget mechanics) is **not
verified** — the reasoning-tokens guide's explicit shared-pool arithmetic is written in an
Anthropic-specific section; other provider sections (e.g. the Gemini 3 `thinkingLevel`
discussion at line 1042) describe different, non-token-precise mechanisms.

**Gemini 3 gotcha (Verified)**, same doc, line 1064: "If you specify `reasoning.max_tokens`
explicitly, OpenRouter will pass it through as `thinkingBudget` to Google's API. However,
for Gemini 3 models, Google internally maps this budget value to a `thinkingLevel`, so you
will not get precise token control. The actual token consumption is still determined by
Google's thinkingLevel implementation, not by the specific budget value you provide." This
is a documented case where the numeric budget does not map precisely to actual token
consumption for a specific model family.

**Models where `max_completion_tokens` is absent / context_length is the only bound:**
**Not verified from documentation prose.** No fetched doc page states a rule for which
models/providers return `null` for `top_provider.max_completion_tokens` or per-endpoint
`max_completion_tokens`, nor confirms the hypothesis that a `null` means "no output cap
beyond context length." The OpenAPI spec only establishes that the field is legally
nullable (type union includes `null`, and it is excluded from `TopProviderInfo.required`);
it does not document the meaning of the null case. This is a **gap** — see below.

---

## Gaps / could not verify

1. **Meaning of `null`** for `top_provider.max_completion_tokens` and per-endpoint
   `max_completion_tokens` / `max_prompt_tokens` is not stated in any fetched doc or the
   OpenAPI spec's `description` strings — only that the field is optional/nullable by type.
   Whether null means "no separate output cap (context-length-bound only)" vs. "data not
   available for this provider" was not found in prose.
2. **Live API verification was not possible in this sandbox.** A direct `curl` to
   `https://openrouter.ai/api/v1/models` from the execution environment returned a
   schema-stub payload (field names/types, not real model data — e.g. `context_length: int`
   literally, not a number) rather than live JSON, indicating the sandbox's network egress
   intercepts/mocks this specific data endpoint. `curl` to `https://openrouter.ai/openapi.json`
   and to the docs site's markdown-source endpoints (`*.md`) worked normally and returned
   real content, which is what all findings above are based on. No live per-model examples
   of `null` vs. populated `max_completion_tokens` in production were obtained this
   session — all examples above are the documentation's illustrative example payloads
   (`openai/gpt-4`), not a live catalog sample.
3. Whether the connection "the metadata field IS the legal ceiling you may pass to the
   `max_tokens`/`max_completion_tokens` request parameter" is explicitly documented
   anywhere was not found — treated as Inferred, not Verified, above.
4. No separate narrative guide page exists for `GET /models/{author}/{slug}/endpoints`
   beyond the OpenAPI-generated reference; only the OpenAPI schema itself was available as
   a source for §2.

## Sources

- https://openrouter.ai/openapi.json (fetched 2026-07-23; `Model`, `TopProviderInfo`,
  `PerRequestLimits`, `ListEndpointsResponse`, `PublicEndpoint`, `ImageModelListItem`,
  `ImageEndpoint`, `VideoModel` schemas)
- https://openrouter.ai/docs/guides/overview/models (Model Object Schema, Top Provider
  Object, Supported Parameters sections)
- https://openrouter.ai/docs/api_reference/parameters (Max Tokens / Max Completion Tokens
  parameter definitions) — canonical URL after redirect from
  `https://openrouter.ai/docs/api-reference/parameters`
- https://openrouter.ai/docs/guides/best-practices/reasoning-tokens (reasoning-token
  billing and budget-sharing semantics, Anthropic and Gemini 3 specifics)
- https://openrouter.ai/docs/api_reference/limits (checked; contains only credit/rate
  limits, no token-cap content — ruled out as a source)
