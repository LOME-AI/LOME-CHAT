import { describe, expect, it } from 'vitest';
import { languageRoutingOptions, mediaRoutingOptions } from './routing-options.js';

describe('languageRoutingOptions', () => {
  it('pins zdr/no-collection/no-fallbacks on the typed provider block', () => {
    const options = languageRoutingOptions();

    expect(options.provider).toEqual({
      zdr: true,
      data_collection: 'deny',
      allow_fallbacks: false,
    });
  });

  it('enables inline usage/cost accounting', () => {
    expect(languageRoutingOptions().usage).toEqual({ include: true });
  });

  it('disables prompt transforms via extraBody, not provider', () => {
    const options = languageRoutingOptions();

    // transforms rides extraBody so it cannot clobber the typed provider block.
    expect(options.extraBody).toEqual({ transforms: [] });
    expect('provider' in options.extraBody).toBe(false);
  });

  it('produces a fresh object each call', () => {
    expect(languageRoutingOptions()).not.toBe(languageRoutingOptions());
  });

  it('sets require_parameters on the provider block when the call carries reasoning', () => {
    const options = languageRoutingOptions({ reasoning: true });

    expect(options.provider).toEqual({
      zdr: true,
      data_collection: 'deny',
      allow_fallbacks: false,
      require_parameters: true,
    });
  });

  it('omits require_parameters entirely when the call carries no reasoning', () => {
    expect('require_parameters' in languageRoutingOptions().provider).toBe(false);
    expect('require_parameters' in languageRoutingOptions({ reasoning: false }).provider).toBe(
      false
    );
  });
});

describe('mediaRoutingOptions', () => {
  it('carries the full provider routing block inside extraBody', () => {
    const options = mediaRoutingOptions();

    // Image/video settings expose no typed provider.zdr, so the whole block
    // rides extraBody.provider (which replaces settings.provider on the wire).
    expect(options.extraBody.provider).toEqual({
      zdr: true,
      data_collection: 'deny',
      allow_fallbacks: false,
    });
  });

  it('disables prompt transforms alongside the provider block', () => {
    expect(mediaRoutingOptions().extraBody.transforms).toEqual([]);
  });

  it('sets no typed top-level provider (nothing for extraBody to replace)', () => {
    expect('provider' in mediaRoutingOptions()).toBe(false);
  });

  it('produces a fresh object each call', () => {
    expect(mediaRoutingOptions()).not.toBe(mediaRoutingOptions());
  });
});
