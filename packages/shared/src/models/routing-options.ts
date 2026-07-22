/**
 * OpenRouter routing/ZDR options, single-sourced per call-family.
 *
 * Every inference call must pin ZDR + no-data-collection + no-fallbacks so a
 * request can never silently route to a provider that retains prompts. The
 * exact shape differs by call-family because of a wire footgun: OpenRouter's
 * `extraBody.provider` REPLACES `settings.provider` in the outgoing body (it
 * does not deep-merge), so mixing the two on one call drops whichever the
 * other omits.
 *
 * - Language (`openrouter.chat`) has a typed `settings.provider` carrying
 *   `zdr`, so the routing block rides there; `transforms: []` (disable prompt
 *   compression) goes in `extraBody` where it cannot clobber `provider`, and
 *   `usage: { include: true }` turns on inline usage/cost accounting.
 * - Image/video model settings expose no typed `provider` with a `zdr` field,
 *   so the WHOLE provider block rides in `extraBody.provider` (alongside
 *   `transforms: []`), with no typed `settings.provider` set — nothing for it
 *   to replace.
 *
 * These are plain data shapes (no dependency on the provider SDK's types); the
 * adapters spread them into the model settings. A lint guard forbids inlining
 * these literals in adapter code so this stays the one source.
 */

/** The provider-routing directives pinned on every inference request. */
export interface OpenRouterProviderRouting {
  readonly zdr: true;
  readonly data_collection: 'deny';
  readonly allow_fallbacks: false;
  /**
   * Present (and `true`) iff the call carries a `reasoning` config: by
   * default OpenRouter lets an endpoint that doesn't implement a parameter
   * silently IGNORE it, so a reasoning request could bill as a plain turn.
   * Restricting routing to endpoints supporting every sent parameter is the
   * guard; it can surface a "no endpoints found" refusal, which the adapter
   * types distinctly. Never set on reasoning-free calls — it would narrow
   * the endpoint pool for no benefit.
   */
  readonly require_parameters?: true;
}

/** The per-call facts the language routing variant keys on. */
export interface LanguageRoutingVariant {
  /** Whether the call carries a `reasoning` config. */
  readonly reasoning: boolean;
}

/** Language-family model settings: typed `provider`, `usage`, and `extraBody`. */
export interface LanguageRoutingOptions {
  readonly provider: OpenRouterProviderRouting;
  readonly usage: { readonly include: true };
  readonly extraBody: { readonly transforms: readonly [] };
}

/** Image/video-family model settings: the provider block rides in `extraBody`. */
export interface MediaRoutingOptions {
  readonly extraBody: {
    readonly provider: OpenRouterProviderRouting;
    readonly transforms: readonly [];
  };
}

function providerRouting(variant?: LanguageRoutingVariant): OpenRouterProviderRouting {
  return {
    zdr: true,
    data_collection: 'deny',
    allow_fallbacks: false,
    ...(variant?.reasoning === true ? { require_parameters: true } : {}),
  };
}

export function languageRoutingOptions(variant?: LanguageRoutingVariant): LanguageRoutingOptions {
  return {
    provider: providerRouting(variant),
    usage: { include: true },
    extraBody: { transforms: [] },
  };
}

export function mediaRoutingOptions(): MediaRoutingOptions {
  return {
    extraBody: { provider: providerRouting(), transforms: [] },
  };
}
