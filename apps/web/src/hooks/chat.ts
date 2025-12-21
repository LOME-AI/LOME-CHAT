import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Conversation, Message, NewConversation, NewMessage } from '@lome-chat/db';

// Query key factory
export const chatKeys = {
  all: ['chat'] as const,
  conversations: () => [...chatKeys.all, 'conversations'] as const,
  conversation: (id: string) => [...chatKeys.conversations(), id] as const,
  messages: (conversationId: string) =>
    [...chatKeys.conversation(conversationId), 'messages'] as const,
};

// Queries (disabled until API exists in Phase 11)
export function useConversations(): ReturnType<typeof useQuery<Conversation[], Error>> {
  return useQuery({
    queryKey: chatKeys.conversations(),
    queryFn: (): Promise<Conversation[]> =>
      Promise.reject(new Error('API not implemented - enable in Phase 11')),
    enabled: false,
  });
}

export function useConversation(id: string): ReturnType<typeof useQuery<Conversation, Error>> {
  return useQuery({
    queryKey: chatKeys.conversation(id),
    queryFn: (): Promise<Conversation> =>
      Promise.reject(new Error('API not implemented - enable in Phase 11')),
    enabled: false,
  });
}

export function useMessages(conversationId: string): ReturnType<typeof useQuery<Message[], Error>> {
  return useQuery({
    queryKey: chatKeys.messages(conversationId),
    queryFn: (): Promise<Message[]> =>
      Promise.reject(new Error('API not implemented - enable in Phase 11')),
    enabled: false,
  });
}

// Mutations (stubs)
export function useCreateConversation(): ReturnType<
  typeof useMutation<Conversation, Error, NewConversation>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (): Promise<Conversation> =>
      Promise.reject(new Error('API not implemented - enable in Phase 11')),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.conversations() });
    },
  });
}

export function useSendMessage(): ReturnType<
  typeof useMutation<Message, Error, { conversationId: string; message: NewMessage }>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (): Promise<Message> =>
      Promise.reject(new Error('API not implemented - enable in Phase 11')),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: chatKeys.messages(variables.conversationId),
      });
    },
  });
}
