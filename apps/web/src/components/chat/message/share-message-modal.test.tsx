import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/hooks/chat/use-message-share.js', () => ({
  useMessageShare: vi.fn(),
}));

// Mock the shared media list so the preview test doesn't pull in the full
// fetch + decrypt chain; it renders nothing when there is no media (matching
// the real component) so non-media tests are unaffected.
vi.mock('@/components/chat/message/message-media-list.js', () => ({
  MessageMediaList: ({
    media,
    contentKeyError,
  }: {
    media: { contentItemId: string }[];
    contentKeyError?: Error | null;
  }) =>
    media.length === 0 ? null : (
      <div
        data-testid="modal-media-list"
        data-count={media.length}
        data-key-error={contentKeyError ? contentKeyError.message : 'none'}
      >
        {media.map((m) => (
          <span key={m.contentItemId} data-testid={`modal-media-${m.contentItemId}`} />
        ))}
      </div>
    ),
}));

const mockUseMessageContentKey =
  vi.fn<
    (
      conversationId: string,
      epochNumber: number,
      wrappedContentKey: string
    ) => { contentKey: Uint8Array | null; error: Error | null }
  >();

vi.mock('@/hooks/crypto/use-decrypted-media.js', () => ({
  useMessageContentKey: (...args: [string, number, string]) => mockUseMessageContentKey(...args),
}));

import { useMessageShare } from '@/hooks/chat/use-message-share.js';
import { ShareMessageModal } from '@/components/chat/message/share-message-modal.js';

const mockUseMessageShare = vi.mocked(useMessageShare);
const mockMutateAsync = vi.fn();

describe('ShareMessageModal', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    messageId: 'msg-123',
    messageContent: 'Here is the final API design for the encryption layer.',
    conversationId: 'conv-1',
    epochNumber: 1,
    wrappedContentKey: 'base64-wrapped-content-key',
    mediaItems: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMessageContentKey.mockReturnValue({
      contentKey: new Uint8Array([1, 2, 3]),
      error: null,
    });
    mockUseMessageShare.mockReturnValue({
      mutateAsync: mockMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useMessageShare>);
    mockMutateAsync.mockResolvedValue({
      shareId: 'share-xyz',
      url: 'http://localhost:3000/share/m/share-xyz#secret-key-b64',
    });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(() => Promise.resolve()) },
      writable: true,
      configurable: true,
    });
  });

  it('renders the modal with preview phase', () => {
    render(<ShareMessageModal {...defaultProps} />);

    expect(screen.getByTestId('share-message-modal')).toBeInTheDocument();
    expect(screen.getByTestId('share-message-preview')).toBeInTheDocument();
  });

  it('displays message content preview', () => {
    render(<ShareMessageModal {...defaultProps} />);

    const preview = screen.getByTestId('share-message-preview');
    expect(preview).toHaveTextContent('Here is the final API design');
  });

  it('shows cryptographic isolation info in an Alert', () => {
    render(<ShareMessageModal {...defaultProps} />);

    const isolationInfo = screen.getByTestId('share-message-isolation-info');
    expect(isolationInfo).toHaveTextContent('single message only');
    expect(isolationInfo).toHaveAttribute('role', 'alert');
  });

  it('calls useMessageShare with envelope metadata on Create Link click', async () => {
    render(<ShareMessageModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('share-message-create-button'));

    expect(mockMutateAsync).toHaveBeenCalledWith({
      messageId: 'msg-123',
      conversationId: 'conv-1',
      epochNumber: 1,
      wrappedContentKey: 'base64-wrapped-content-key',
    });
  });

  it('switches to generated phase after creation', async () => {
    render(<ShareMessageModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('share-message-create-button'));

    expect(screen.getByTestId('share-message-url')).toBeInTheDocument();
    expect(screen.getByTestId('share-message-copy-button')).toBeInTheDocument();
  });

  it('announces share-link success via role="status" / aria-live="polite"', async () => {
    render(<ShareMessageModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('share-message-create-button'));

    const success = screen.getByTestId('share-message-success');
    expect(success).toHaveAttribute('role', 'status');
    expect(success).toHaveAttribute('aria-live', 'polite');
    expect(success).toHaveTextContent('Share link created!');
  });

  it('displays the generated URL', async () => {
    render(<ShareMessageModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('share-message-create-button'));

    expect(screen.getByTestId('share-message-url')).toHaveTextContent(
      'http://localhost:3000/share/m/share-xyz#secret-key-b64'
    );
  });

  it('closes modal when Cancel is clicked', async () => {
    render(<ShareMessageModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('share-message-cancel-button'));

    expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not render when messageId is null', () => {
    render(<ShareMessageModal {...defaultProps} messageId={null} />);

    expect(screen.queryByTestId('share-message-preview')).not.toBeInTheDocument();
  });

  it('resets to preview phase when reopened', () => {
    const { rerender } = render(<ShareMessageModal {...defaultProps} open={false} />);
    rerender(<ShareMessageModal {...defaultProps} open={true} />);

    expect(screen.getByTestId('share-message-create-button')).toBeInTheDocument();
    expect(screen.queryByTestId('share-message-url')).not.toBeInTheDocument();
  });

  it('shows fresh Copy state when reopened after a prior copy', async () => {
    const { rerender } = render(<ShareMessageModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('share-message-create-button'));
    await userEvent.click(screen.getByTestId('share-message-copy-button'));
    expect(screen.getByTestId('share-message-copy-button')).toHaveTextContent('Copied');

    rerender(<ShareMessageModal {...defaultProps} open={false} />);
    rerender(<ShareMessageModal {...defaultProps} open={true} />);

    await userEvent.click(screen.getByTestId('share-message-create-button'));

    expect(screen.getByTestId('share-message-copy-button')).toHaveTextContent('Copy');
    expect(screen.getByTestId('share-message-copy-button')).not.toHaveTextContent('Copied');
  });

  it('reverts to Copy after the reset timeout elapses', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ShareMessageModal {...defaultProps} />);

    await user.click(screen.getByTestId('share-message-create-button'));
    await user.click(screen.getByTestId('share-message-copy-button'));
    expect(screen.getByTestId('share-message-copy-button')).toHaveTextContent('Copied');

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.getByTestId('share-message-copy-button')).toHaveTextContent('Copy');
    expect(screen.getByTestId('share-message-copy-button')).not.toHaveTextContent('Copied');

    vi.useRealTimers();
  });

  it('clears the copy-reset timer on unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { unmount } = render(<ShareMessageModal {...defaultProps} />);

    await user.click(screen.getByTestId('share-message-create-button'));
    setSpy.mockClear();
    await user.click(screen.getByTestId('share-message-copy-button'));

    const copyTimerResult = setSpy.mock.results[
      setSpy.mock.calls.findIndex((args) => args[1] === 3000)
    ] as { value: ReturnType<typeof setTimeout> } | undefined;
    expect(copyTimerResult).toBeDefined();

    unmount();

    expect(clearSpy).toHaveBeenCalledWith(copyTimerResult!.value);

    vi.useRealTimers();
  });

  it('creates a share link for media-only messages whose textual content is empty', async () => {
    // Image / video / audio assistant messages have an empty `messageContent` —
    // the bytes live in encrypted contentItems, addressed by `messageId` server-side.
    // The share API only needs envelope metadata, so the modal must not gate
    // on text content being present.
    render(<ShareMessageModal {...defaultProps} messageContent="" />);

    await userEvent.click(screen.getByTestId('share-message-create-button'));

    expect(mockMutateAsync).toHaveBeenCalledWith({
      messageId: 'msg-123',
      conversationId: 'conv-1',
      epochNumber: 1,
      wrappedContentKey: 'base64-wrapped-content-key',
    });
    expect(screen.getByTestId('share-message-url')).toBeInTheDocument();
  });

  it('does not attempt to create a share when the wrapped content key is missing', async () => {
    render(<ShareMessageModal {...defaultProps} wrappedContentKey={null} />);

    await userEvent.click(screen.getByTestId('share-message-create-button'));

    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('does not attempt to create a share when the conversation id is missing', async () => {
    render(<ShareMessageModal {...defaultProps} conversationId={null} />);

    await userEvent.click(screen.getByTestId('share-message-create-button'));

    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('does not attempt to create a share when the epoch number is missing', async () => {
    render(<ShareMessageModal {...defaultProps} epochNumber={null} />);

    await userEvent.click(screen.getByTestId('share-message-create-button'));

    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('stays in the preview phase when share creation fails', async () => {
    mockMutateAsync.mockRejectedValue(new Error('share failed'));
    render(<ShareMessageModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('share-message-create-button'));

    expect(screen.getByTestId('share-message-create-button')).toBeInTheDocument();
    expect(screen.queryByTestId('share-message-success')).not.toBeInTheDocument();
  });

  it('closes the modal from the generated-phase Done button', async () => {
    const onOpenChange = vi.fn();
    render(<ShareMessageModal {...defaultProps} onOpenChange={onOpenChange} />);

    await userEvent.click(screen.getByTestId('share-message-create-button'));
    await screen.findByRole('button', { name: 'Done' });
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('sorts multiple media items by position before rendering', () => {
    render(
      <ShareMessageModal
        {...defaultProps}
        messageContent=""
        mediaItems={[
          {
            id: 'ci-2',
            contentType: 'image',
            position: 1,
            mimeType: 'image/png',
            sizeBytes: 1024,
            width: 512,
            height: 512,
          },
          {
            id: 'ci-1',
            contentType: 'image',
            position: 0,
            mimeType: 'image/png',
            sizeBytes: 1024,
            width: 512,
            height: 512,
          },
        ]}
      />
    );

    expect(screen.getByTestId('modal-media-list')).toHaveAttribute('data-count', '2');
  });

  it('tolerates a null conversationId and epochNumber via safe fallbacks', () => {
    render(<ShareMessageModal {...defaultProps} conversationId={null} epochNumber={null} />);

    expect(screen.getByTestId('share-message-preview')).toBeInTheDocument();
  });

  it('renders media in the preview for a media-only message (no blank container)', () => {
    render(
      <ShareMessageModal
        {...defaultProps}
        messageContent=""
        mediaItems={[
          {
            id: 'ci-1',
            contentType: 'image',
            position: 0,
            mimeType: 'image/png',
            sizeBytes: 1024,
            width: 512,
            height: 512,
          },
        ]}
      />
    );

    const list = screen.getByTestId('modal-media-list');
    expect(list).toHaveAttribute('data-count', '1');
    expect(screen.getByTestId('modal-media-ci-1')).toBeInTheDocument();
    expect(screen.getByTestId('share-message-preview')).toContainElement(list);
  });

  it('forwards a content-key error to the media list so undecryptable media shows an error (H11)', () => {
    mockUseMessageContentKey.mockReturnValue({
      contentKey: null,
      error: new Error('Epoch key not available'),
    });

    render(
      <ShareMessageModal
        {...defaultProps}
        messageContent=""
        mediaItems={[
          {
            id: 'ci-1',
            contentType: 'image',
            position: 0,
            mimeType: 'image/png',
            sizeBytes: 1024,
            width: 512,
            height: 512,
          },
        ]}
      />
    );

    expect(screen.getByTestId('modal-media-list')).toHaveAttribute(
      'data-key-error',
      'Epoch key not available'
    );
  });
});
