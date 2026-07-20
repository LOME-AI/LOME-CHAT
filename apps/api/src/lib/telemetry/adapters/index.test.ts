import { describe, expect, it } from 'vitest';
import * as barrel from './index.js';

describe('telemetry adapters barrel', () => {
  it('exports the adapter factory and the console patch', () => {
    expect(typeof barrel.createSentryTelemetry).toBe('function');
    expect(typeof barrel.installProductionConsolePatch).toBe('function');
  });

  it('exports the scrub and lock-down seams for composition and audit', () => {
    expect(typeof barrel.scrubSentryEvent).toBe('function');
    expect(typeof barrel.sentryClientOptions).toBe('function');
  });
});
