import { createRealtimeBroadcast } from '../slices/conversations/index.js';
import type { EnvContext } from '@hushbox/shared';
import type { RealtimeBroadcast } from '../slices/conversations/index.js';

/**
 * The structural slice of the Worker env this binding needs. Typed optional
 * because runtime cannot guarantee a wrangler binding; a missing namespace is
 * a deployment misconfiguration and fails fast below. Extends EnvContext
 * (the `EmailSenderEnv` pattern) so `Bindings` — which does not declare the
 * namespace — stays assignable despite the otherwise-weak optional shape.
 */
export interface ConversationRoomEnv extends EnvContext {
  readonly CONVERSATION_ROOM?: DurableObjectNamespace;
}

/** The production binding for conversations' realtime dep: the ConversationRoom DO client. */
export function createConversationRoomRealtime(env: ConversationRoomEnv): RealtimeBroadcast {
  if (env.CONVERSATION_ROOM === undefined) {
    throw new Error(
      'CONVERSATION_ROOM Durable Object binding is missing. ' +
        'Set it in wrangler config — realtime composition fails fast instead of degrading.'
    );
  }
  return createRealtimeBroadcast(env.CONVERSATION_ROOM);
}
