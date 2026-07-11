import { createEpochPublicKeyReader } from '../conversations/index.js';
import { createChatStores } from './adapters/stores.js';
import { createChatManifest as createChatRoutesManifest } from './routes.js';
import type { ChatRouteDeps } from './domain/index.js';

/**
 * The chat slice's public manifest composer. Routes and domain may not reach
 * the slice's own adapters (boundaries), so this slice-root module — the same
 * seam pattern as `conversation-runtime.ts` — supplies the two adapter
 * defaults the user-only message write needs: chat's own content persister
 * and the `epochs` wrap-key reader the conversations slice publishes (single
 * writer of `epochs`). The composition root's call shape is unchanged; a test
 * may still inject either.
 */

type ChatManifestDeps = Omit<ChatRouteDeps, 'chatStores' | 'readEpochPublicKey'> & {
  readonly chatStores?: ChatRouteDeps['chatStores'];
  readonly readEpochPublicKey?: ChatRouteDeps['readEpochPublicKey'];
};

export function createChatManifest(
  deps: ChatManifestDeps
): ReturnType<typeof createChatRoutesManifest> {
  return createChatRoutesManifest({
    ...deps,
    chatStores: deps.chatStores ?? createChatStores(),
    readEpochPublicKey: deps.readEpochPublicKey ?? createEpochPublicKeyReader(),
  });
}
