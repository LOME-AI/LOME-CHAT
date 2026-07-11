import { createConversationRoomClass } from '@hushbox/realtime';
import { createRoomBindings } from '../slices/conversations/adapters/realtime-room-bindings.js';
import { createChatConversationRuntime } from '../slices/chat/index.js';
import { checkSessionLiveness } from '../slices/identity/index.js';
import { createMessagePushNotify } from './push-notify.js';
import type { Bindings } from '../lib/context/app-env.js';

/**
 * The bound ConversationRoom class behind the wrangler DO binding
 * (CONVERSATION_ROOM), one instance per conversation (via `idFromName`).
 *
 * Composition only — this module imports `cloudflare:workers` transitively
 * (via `@hushbox/realtime`) and therefore cannot load in the node-environment
 * test project; it is coverage-excluded. The room's runtime (chat's
 * conversation-runtime factory) and the broadcast-time session backstop
 * (identity's session-liveness read) are composed here, in an adapter (which
 * may cross slice barrels), rather than in the conversations adapter (which
 * may import neither the chat nor the identity barrel) — so the running room
 * executes real turns and cuts revoked sessions' sockets. Everything testable
 * lives in `realtime-room-bindings.ts` (which exercises this exact triple)
 * and in `@hushbox/realtime`'s plain room modules.
 */
export const ConversationRoom = createConversationRoomClass<Bindings>((env) =>
  createRoomBindings(
    env,
    createChatConversationRuntime,
    checkSessionLiveness,
    createMessagePushNotify
  )
);
