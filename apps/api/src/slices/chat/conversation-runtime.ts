import { createEnvUtilities } from '@hushbox/shared';
import { mockProviderEnabled } from '../models/index.js';
import { createR2StorageFromEnv } from '../media/index.js';
import { createConversationRuntime } from './domain/runtime.js';
import { createChatStores } from './adapters/stores.js';
import type { ConversationRuntime, ConversationRuntimeDeps } from './domain/runtime.js';
import type { Bindings } from '../../lib/context/index.js';

/**
 * The chat slice's public composer for the ConversationRoom runtime: it reads
 * the inference key from the DO's env bindings and wires chat's own content
 * persister (`createChatStores`) into the runtime the DO consumes. Chat's
 * domain cannot reach its own adapter, and the conversations adapter cannot
 * reach chat's domain — this slice-root module is the seam that joins them.
 *
 * The conversations adapter injects this factory into `createRoomBindings`
 * (packages never import apps; the adapter never imports chat), so boundaries
 * hold with no rule relaxation.
 */

/** Infra deps; the key and CI classification are derived from `env`, the content persister is internal. */
export type ChatConversationRuntimeDeps = Omit<
  ConversationRuntimeDeps,
  'chatStores' | 'apiKey' | 'isCI' | 'storage'
> & {
  readonly env: Bindings;
};

/**
 * The OpenRouter key from the DI'd env binding (never `process.env`, never a
 * cast — `OPENROUTER_API_KEY` is a typed field on `Bindings`, defined by the
 * env.config registry). `createEnvUtilities` classifies the environment but
 * carries no config values, so the value is read from the typed binding here.
 */
function requiredOpenRouterKey(env: Bindings): string {
  const value = env.OPENROUTER_API_KEY;
  if (typeof value !== 'string' || value === '') {
    throw new Error(
      'chat runtime: missing required binding OPENROUTER_API_KEY. ' +
        'Set it in wrangler config / .dev.vars — the runtime fails fast instead of degrading.'
    );
  }
  return value;
}

export function createChatConversationRuntime(
  deps: ChatConversationRuntimeDeps
): ConversationRuntime {
  // Dev / E2E route inference through the deterministic `x-mock-*` mock provider
  // (legacy parity); production and CI-vitest use real OpenRouter. This env-mode
  // decision — computed from the DO's OWN env bindings — is the DO-side gate that
  // makes the mock production-inert: the runtime constructs the mock only when
  // this is true AND a run carries per-request `mockDirectives` (threaded through
  // `RunStartBody`). The real path alone requires the OpenRouter key, so local
  // dev can run with no key set.
  const envUtilities = createEnvUtilities(deps.env);
  const useMock = mockProviderEnabled(envUtilities);
  return createConversationRuntime({
    db: deps.db,
    redis: deps.redis,
    telemetry: deps.telemetry,
    apiKey: useMock ? '' : requiredOpenRouterKey(deps.env),
    mockProviderEnabled: useMock,
    // Selects the CI-vitest cassette + evidence wiring vs production plain-fetch
    // on the real inference path (the provider factory's single source of truth).
    isCI: envUtilities.isCI,
    chatStores: createChatStores(),
    // The media-run persist path (pre-minted keys, encrypt-and-store mappers).
    // Built eagerly from the DO's own R2 bindings — a missing binding fails
    // construction fast rather than failing the first media turn.
    storage: createR2StorageFromEnv(deps.env, deps.db),
    readEpochPublicKey: deps.readEpochPublicKey,
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.newId === undefined ? {} : { newId: deps.newId }),
  });
}
