import { describe, expect, it } from 'vitest';

import config, { resolveWebContentsDebugging } from '../capacitor.config';

describe('resolveWebContentsDebugging', () => {
  it('disables WebView debugging for release (production) builds', () => {
    expect(resolveWebContentsDebugging('production')).toBe(false);
  });

  it('enables WebView debugging for development builds', () => {
    expect(resolveWebContentsDebugging('development')).toBe(true);
  });

  it('defaults to disabled when the Capacitor CLI provides no NODE_ENV', () => {
    // An unset env key reads as `undefined` — the real bare-`cap sync` case.
    expect(resolveWebContentsDebugging(process.env['HB_UNSET_NODE_ENV_PROBE'])).toBe(false);
  });

  it('wires the resolved value into the Android config', () => {
    expect(config.android?.webContentsDebuggingEnabled).toBe(
      resolveWebContentsDebugging(process.env['NODE_ENV'])
    );
  });
});
