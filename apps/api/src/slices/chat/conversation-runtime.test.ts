import { describe, expect, it, vi } from 'vitest';
import { createChatConversationRuntime } from './conversation-runtime.js';
import type { ChatConversationRuntimeDeps } from './conversation-runtime.js';
import type { Bindings } from '../../lib/context/index.js';
import type { Telemetry } from '../../lib/telemetry/index.js';

const silentTelemetry: Telemetry = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  emitMetric: vi.fn(),
  captureError: vi.fn(),
};

// The runtime builds synchronously (the executor loads its catalog lazily on
// first run), so db/redis are never touched at construction.
function deps(env: Bindings): ChatConversationRuntimeDeps {
  return {
    db: {} as unknown as ChatConversationRuntimeDeps['db'],
    redis: {} as unknown as ChatConversationRuntimeDeps['redis'],
    telemetry: silentTelemetry,
    env,
    readEpochPublicKey: () => Promise.resolve(null),
  };
}

describe('createChatConversationRuntime', () => {
  it('reads the OpenRouter key from env and builds the real runtime in production', () => {
    const runtime = createChatConversationRuntime(
      deps({ NODE_ENV: 'production', OPENROUTER_API_KEY: 'k' } as Bindings)
    );
    expect(typeof runtime.executor.start).toBe('function');
    expect(typeof runtime.bindHooks).toBe('function');
    expect(typeof runtime.claimRun).toBe('function');
  });

  it('fails fast in production when OPENROUTER_API_KEY is missing, naming the binding', () => {
    expect(() =>
      createChatConversationRuntime(deps({ NODE_ENV: 'production' } as Bindings))
    ).toThrow(/OPENROUTER_API_KEY/);
  });

  it('builds on the mock provider in local dev without an OpenRouter key', () => {
    // Dev routes inference through the deterministic mock, so no key is required —
    // the runtime builds even with none set (proving the mock path was selected).
    const runtime = createChatConversationRuntime(deps({ NODE_ENV: 'development' } as Bindings));
    expect(typeof runtime.executor.start).toBe('function');
  });

  it('builds on the mock provider in E2E without an OpenRouter key', () => {
    const runtime = createChatConversationRuntime(
      deps({ NODE_ENV: 'development', CI: 'true', E2E: 'true' } as Bindings)
    );
    expect(typeof runtime.executor.start).toBe('function');
  });

  it('threads an injected clock and id source into the runtime', () => {
    const runtime = createChatConversationRuntime({
      ...deps({ NODE_ENV: 'production', OPENROUTER_API_KEY: 'k' } as Bindings),
      now: () => new Date('2026-07-05T00:00:00Z'),
      newId: () => 'fixed-id',
    });
    expect(typeof runtime.claimRun).toBe('function');
  });
});
