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

/** Infra deps; the key is read from `env`, the content persister is internal. */
export type ChatConversationRuntimeDeps = Omit<ConversationRuntimeDeps, 'chatStores' | 'apiKey'> & {
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
  return createConversationRuntime({
    db: deps.db,
    redis: deps.redis,
    telemetry: deps.telemetry,
    apiKey: requiredOpenRouterKey(deps.env),
    chatStores: createChatStores(),
    readEpochPublicKey: deps.readEpochPublicKey,
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.newId === undefined ? {} : { newId: deps.newId }),
  });
}
