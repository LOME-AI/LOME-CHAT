import { createConversationRoomClass } from '@hushbox/realtime';
import { createRoomBindings } from './realtime-room-bindings.js';
import type { Bindings } from '../../../lib/context/app-env.js';

/**
 * The bound ConversationRoom class behind the wrangler DO binding
 * (CONVERSATION_ROOM). Composition only — this module imports
 * `cloudflare:workers` transitively and therefore cannot load in the
 * node-environment test project; everything testable lives in
 * realtime-room-bindings.ts and in `@hushbox/realtime`'s plain modules.
 */
export const ConversationRoom = createConversationRoomClass<Bindings>(() => createRoomBindings());
