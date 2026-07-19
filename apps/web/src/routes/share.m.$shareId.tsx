import * as React from 'react';
import { useMemo } from 'react';
import { createFileRoute, useParams } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';
import { TEST_IDS } from '@hushbox/shared';
import { MarkdownRenderer } from '@/components/chat/message/markdown-renderer.js';
import { MessageBody } from '@/components/chat/message/message-body.js';
import { useSharedMessage, type SharedContentItem } from '@/hooks/chat/use-shared-message.js';
import { AppShell } from '../components/shared/app-shell.js';
import type { RenderableMedia } from '@/components/chat/media/media-content-item.js';

export const Route = createFileRoute('/share/m/$shareId')({
  component: SharedMessagePage,
});

function SharedMessagePage(): React.JSX.Element {
  const { shareId } = useParams({ from: '/share/m/$shareId' });
  const keyBase64 = useMemo(() => globalThis.location.hash.slice(1) || null, []);

  const { data, isLoading, isError } = useSharedMessage(shareId, keyBase64);

  if (isLoading) {
    return (
      <div
        data-testid={TEST_IDS.sharedMessageLoading}
        role="status"
        aria-live="polite"
        className="flex h-full items-center justify-center"
      >
        <span className="text-muted-foreground text-sm">Decrypting shared message...</span>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <AppShell>
        <div
          data-testid={TEST_IDS.sharedMessageError}
          role="alert"
          className="flex flex-1 items-center justify-center"
        >
          <div className="flex flex-col items-center gap-3">
            <AlertTriangle className="text-muted-foreground h-8 w-8" />
            <h2 className="text-lg font-semibold">Unable to access message</h2>
            <p className="text-muted-foreground text-sm">
              This share link may be invalid or expired.
            </p>
          </div>
        </div>
      </AppShell>
    );
  }

  // Render the shared message through the same MessageBody the chat uses, so
  // media looks identical to a regular conversation. Text-then-media mirrors how
  // an assistant message renders in chat (a single content block, then media).
  const textItems = data.contentItems.filter(
    (item): item is Extract<SharedContentItem, { type: 'text' }> => item.type === 'text'
  );
  const media: RenderableMedia[] = data.contentItems
    .filter((item): item is Extract<SharedContentItem, { type: 'media' }> => item.type === 'media')
    .map((item) => ({
      contentItemId: item.contentItemId,
      contentType: item.contentType,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      width: item.width,
      height: item.height,
      downloadUrl: item.downloadUrl,
    }));

  return (
    <AppShell>
      <div className="flex flex-1 flex-col overflow-y-auto px-4 py-8">
        <div className="mx-auto w-full max-w-3xl">
          <h1 className="text-muted-foreground mb-2 px-4 text-sm font-medium">Shared message</h1>
          <div data-testid={TEST_IDS.sharedMessageContent}>
            <MessageBody
              variant="assistant"
              media={media}
              contentKey={data.contentKey}
              ariaPrefix="Shared"
            >
              {textItems.length > 0 && (
                <div className="w-full overflow-hidden text-base leading-relaxed break-words">
                  {textItems.map((item) => (
                    <MarkdownRenderer
                      key={`text-${String(item.position)}`}
                      content={item.content}
                    />
                  ))}
                </div>
              )}
            </MessageBody>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
