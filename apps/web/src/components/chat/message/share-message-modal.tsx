import * as React from 'react';
import { useState, useEffect } from 'react';
import { Lock, Link as LinkIcon } from 'lucide-react';
import {
  Overlay,
  ModalActions,
  Alert,
  OverlayContent,
  OverlayHeader,
  InlineFormError,
  useAsyncAction,
} from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { useMessageShare } from '@/hooks/chat/use-message-share.js';
import { useMessageContentKey } from '@/hooks/crypto/use-decrypted-media.js';
import { MessageMediaList } from '@/components/chat/message/message-media-list.js';
import {
  buildMessageEnvelopeContext,
  messageMediaToRenderable,
  type MessageEnvelopeContext,
} from '@/components/chat/media/media-content-item.js';
import type { MessageMediaItem } from '@/lib/api.js';

interface ShareMessageModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messageId: string | null;
  messageContent: string | null;
  /** Conversation the message belongs to — needed to look up the epoch key. */
  conversationId: string | null;
  /** Epoch number the message was encrypted under. */
  epochNumber: number | null;
  /** Base64-encoded wrapped content key from the message envelope. */
  wrappedContentKey: string | null;
  /**
   * The message's sender id — the final field of the content-location AAD the
   * media preview must reconstruct to decrypt member/epoch media. Absent/null
   * means the preview can't build the envelope and media stays unresolved.
   */
  senderId?: string | null;
  /** Media items on the message — shown in the preview the same way as chat. */
  mediaItems: MessageMediaItem[] | null;
}

interface ShareContentInput {
  messageId: string | null;
  messageContent: string | null;
  /** Rendered media list for the preview (null when the message has no media). */
  mediaPreview: React.ReactNode;
  generatedUrl: string | null;
  copied: boolean;
  isPending: boolean;
  onCancel: () => void;
  onCreate: () => Promise<void>;
  onClose: () => void;
  onCopy: () => void;
}

function renderShareContent(input: Readonly<ShareContentInput>): React.JSX.Element {
  if (!input.messageId) {
    return (
      <div className="text-muted-foreground py-4 text-center text-sm">No message selected.</div>
    );
  }

  if (input.generatedUrl === null) {
    return (
      <>
        <div
          data-testid={TEST_IDS.shareMessagePreview}
          className="border-border rounded-md border p-3"
        >
          {input.messageContent !== null && input.messageContent !== '' && (
            <p className="line-clamp-4 text-sm">{input.messageContent}</p>
          )}
          {input.mediaPreview}
        </div>

        <Alert variant="default" data-testid={TEST_IDS.shareMessageIsolationInfo}>
          <Lock />
          <span>
            Cryptographically isolated. This link gives access to this single message only.
          </span>
        </Alert>

        <ModalActions
          cancel={{
            label: 'Cancel',
            onClick: input.onCancel,
            testId: TEST_IDS.shareMessageCancelButton,
          }}
          primary={{
            label: 'Create Link',
            onClick: () => {
              void input.onCreate();
            },
            disabled: input.isPending,
            testId: TEST_IDS.shareMessageCreateButton,
          }}
        />
      </>
    );
  }

  return (
    <>
      <div
        data-testid={TEST_IDS.shareMessageSuccess}
        role="status"
        aria-live="polite"
        className="flex items-center gap-2 text-sm text-green-600"
      >
        <LinkIcon className="h-4 w-4" />
        <span>Share link created!</span>
      </div>

      <div
        data-testid={TEST_IDS.shareMessageUrl}
        className="bg-muted overflow-hidden rounded-md p-3 text-xs break-all"
      >
        {input.generatedUrl}
      </div>

      <ModalActions
        cancel={{
          label: 'Done',
          onClick: input.onClose,
        }}
        primary={{
          label: input.copied ? 'Copied' : 'Copy',
          onClick: input.onCopy,
          testId: TEST_IDS.shareMessageCopyButton,
        }}
      />
    </>
  );
}

export function ShareMessageModal({
  open,
  onOpenChange,
  messageId,
  messageContent,
  conversationId,
  epochNumber,
  wrappedContentKey,
  senderId,
  mediaItems,
}: Readonly<ShareMessageModalProps>): React.JSX.Element {
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Drive the "Copied" → "Copy" reset from an effect so the timer is owned by
  // React: it's cleared on unmount and when copy is pressed again before it
  // elapses, preventing a state update on an unmounted component.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => {
      setCopied(false);
    }, 3000);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);

  const share = useMessageShare();
  const mutateAsync = share.mutateAsync;
  const asyncAction = useAsyncAction();
  const isPending = asyncAction.isPending;

  // Resolve the content key the same way the chat does so the preview renders
  // media identically. The sender is an authenticated member, so the epoch key
  // is already cached; MessageMediaList renders nothing when there's no media.
  const {
    contentKey,
    wrappedContentKey: contentKeyWrap,
    error: contentKeyError,
  } = useMessageContentKey(conversationId ?? '', epochNumber ?? 0, wrappedContentKey ?? '');
  const envelopeContext: MessageEnvelopeContext | undefined = buildMessageEnvelopeContext({
    contentKey,
    wrappedContentKey: contentKeyWrap,
    conversationId,
    messageId,
    epochNumber,
    senderId,
  });
  const media = (mediaItems ?? [])
    .toSorted((a, b) => a.position - b.position)
    .map((item) => messageMediaToRenderable(item, envelopeContext));

  const [previousOpen, setPreviousOpen] = useState(open);
  if (open !== previousOpen) {
    setPreviousOpen(open);
    setGeneratedUrl(null);
    setCopied(false);
    asyncAction.clearError();
  }

  async function handleCreate(): Promise<void> {
    // Media-only assistant messages (image/video/audio) carry empty
    // `messageContent` — the bytes live in encrypted contentItems addressed
    // by `messageId` server-side. The share API only needs envelope metadata,
    // so don't gate on textual content being present.
    if (!messageId || !conversationId || epochNumber == null || !wrappedContentKey) {
      return;
    }

    const result = await asyncAction.run(async () =>
      mutateAsync({
        messageId,
        conversationId,
        epochNumber,
        wrappedContentKey,
      })
    );

    if (result.ok) setGeneratedUrl(result.value.url);
  }

  function handleCancel(): void {
    onOpenChange(false);
  }

  function handleCopy(): void {
    if (generatedUrl) {
      void navigator.clipboard.writeText(generatedUrl);
      setCopied(true);
    }
  }

  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="Share Message"
      dismissible={!isPending}
    >
      <OverlayContent data-testid={TEST_IDS.shareMessageModal}>
        <OverlayHeader title="Share Message" />

        {renderShareContent({
          messageId,
          messageContent,
          mediaPreview: (
            <MessageMediaList
              media={media}
              // Member media decrypts via each item's `envelope`; the legacy
              // message-level content-key channel is unused on this path.
              contentKey={null}
              contentKeyError={contentKeyError}
              ariaPrefix="Generated"
            />
          ),
          generatedUrl,
          copied,
          isPending,
          onCancel: handleCancel,
          onCreate: handleCreate,
          onClose: () => {
            onOpenChange(false);
          },
          onCopy: handleCopy,
        })}

        <InlineFormError error={asyncAction.error} errorKey={asyncAction.errorKey} />
      </OverlayContent>
    </Overlay>
  );
}
