import * as React from 'react';
import { isLocalRun } from '@/lib/run-ownership.js';
import type { ConversationWebSocket } from '@/lib/ws-client.js';

export interface PhantomMessage {
  content: string;
  senderType: 'user' | 'ai';
  senderId?: string;
  modelName?: string;
}

/**
 * Renders OTHER members' live runs. Every room socket receives the same
 * `stream`/run frames; runs this tab started are already rendered by the send
 * path, so they are filtered out via run ownership (frames arriving before
 * the local POST resolves count as local — one run per conversation makes
 * that safe). Phantom tiles are keyed by streamId, labeled by each stream's
 * `stream-start`, and cleared on run-finished — the sync hook's refetch then
 * renders the persisted rows.
 */
export function useRemoteStreaming(ws: ConversationWebSocket | null): Map<string, PhantomMessage> {
  const [phantoms, setPhantoms] = React.useState<Map<string, PhantomMessage>>(new Map());
  // Whether the currently-live run is remote. null = no run observed yet;
  // stream frames arriving without a run-started verdict are held back (the
  // legacy hook similarly ignored unattributable tokens).
  const remoteRunRef = React.useRef<boolean | null>(null);
  const streamModelsRef = React.useRef(new Map<string, string>());

  React.useEffect(() => {
    if (!ws) return;

    const conversationId = ws.conversationId;
    const unsubscribe = ws.onRunFrame((frame) => {
      if (frame.type === 'run-started') {
        remoteRunRef.current = !isLocalRun(conversationId, frame.runId);
        streamModelsRef.current.clear();
        return;
      }
      if (frame.type === 'run-finished') {
        remoteRunRef.current = null;
        streamModelsRef.current.clear();
        // The persisted rows arrive via the run-finished refetch; keeping the
        // phantom would double-render beside them.
        setPhantoms(new Map());
        return;
      }
      if (frame.type !== 'stream' || remoteRunRef.current !== true) return;

      const event = frame.event;
      if (event.kind === 'stream-start') {
        streamModelsRef.current.set(frame.streamId, event.modelId);
        setPhantoms((previous) => {
          const next = new Map(previous);
          next.set(frame.streamId, {
            content: '',
            senderType: 'ai',
            modelName: event.modelId,
          });
          return next;
        });
        return;
      }
      if (event.kind !== 'text-delta') return;
      setPhantoms((previous) => {
        const next = new Map(previous);
        const existing = next.get(frame.streamId);
        if (existing) {
          next.set(frame.streamId, { ...existing, content: existing.content + event.content });
        } else {
          const modelName = streamModelsRef.current.get(frame.streamId);
          next.set(frame.streamId, {
            content: event.content,
            senderType: 'ai',
            ...(modelName !== undefined && { modelName }),
          });
        }
        return next;
      });
    });

    return (): void => {
      unsubscribe();
    };
  }, [ws]);

  return phantoms;
}
