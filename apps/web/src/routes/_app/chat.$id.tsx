import * as React from 'react';
import { z } from 'zod';
import { createFileRoute, useLocation } from '@tanstack/react-router';
import { requireAuth } from '@/lib/auth';
import { AuthenticatedChatPage } from '@/components/chat/page/authenticated-chat-page';
import { ErrorBoundary } from '@/components/shared/error-boundary';
import { conversationQueryOptions } from '@/hooks/chat/chat';
import { keyChainQueryOptions } from '@/hooks/crypto/keys';
import { resolveChatPageKey } from '@/lib/chat/auth-chat-helpers';

export interface ChatSearch {
  fork: string | undefined;
}

const forkSchema = z.string();

export const Route = createFileRoute('/_app/chat/$id')({
  beforeLoad: async ({ params, context }) => {
    // Fire the prefetches before awaiting auth so the `/auth/me` round-trip
    // overlaps them. Safe: the server still authorizes (404 to non-members,
    // ciphertext-only key wraps), decryption needs the private key, and an
    // unauthenticated boot still rejects below before the route mounts. `new`
    // is the create-mode sentinel — fetching it would 404.
    if (params.id !== 'new') {
      void context.queryClient.prefetchQuery(conversationQueryOptions(params.id));
      void context.queryClient.prefetchQuery(keyChainQueryOptions(params.id));
    }
    await requireAuth();
  },
  component: AuthenticatedChatWithErrorBoundary,
  validateSearch: (search: Record<string, unknown>): ChatSearch => {
    const fork = forkSchema.safeParse(search['fork']);
    return { fork: fork.success ? fork.data : undefined };
  },
});

function AuthenticatedChatWithErrorBoundary(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <AuthenticatedChat />
    </ErrorBoundary>
  );
}

function AuthenticatedChat(): React.JSX.Element {
  const { id } = Route.useParams();
  const { fork } = Route.useSearch();
  const { state } = useLocation();

  // Key by the conversation id so switching conversations remounts the chat
  // subtree, resetting all per-conversation state (typing, presence, phantoms,
  // forks). The one exception is the create→real hop: after the first message
  // the hook navigates `/chat/new` → `/chat/<realId>` (marked `fromCreate`) for
  // the SAME just-created conversation. Remounting there would discard
  // optimistic-only state with no DB row — notably failed-model error tiles —
  // so the key is held stable across exactly that transition. Adjust-state-in-
  // render keeps it concurrent-safe (no effect, no render-time ref mutation).
  const [keyState, setKeyState] = React.useState({ prevId: id, key: id });
  const next = resolveChatPageKey(keyState, id, state.fromCreate === true);
  if (next !== keyState) setKeyState(next);

  return <AuthenticatedChatPage key={next.key} routeConversationId={id} initialForkId={fork} />;
}
