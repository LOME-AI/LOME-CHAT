import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { LegacyContentKey } from '@hushbox/crypto';
import type { RenderableMedia } from '@/components/chat/media/media-content-item';

vi.mock('@/components/chat/message/message-media-list', () => ({
  MessageMediaList: ({
    media,
    contentKey,
    contentKeyError,
    ariaPrefix,
  }: {
    media: RenderableMedia[];
    contentKey: LegacyContentKey | null;
    contentKeyError: Error | null;
    ariaPrefix: string;
  }) => (
    <div
      data-testid="media-list"
      data-count={media.length}
      data-aria-prefix={ariaPrefix}
      data-has-key={contentKey === null ? 'no' : 'yes'}
      data-key-error={contentKeyError === null ? 'none' : contentKeyError.message}
    />
  ),
}));

import { MessageBody } from '@/components/chat/message/message-body';

const key = new Uint8Array([1, 2, 3]) as LegacyContentKey;

function media(contentItemId: string): RenderableMedia {
  return {
    contentItemId,
    contentType: 'image',
    mimeType: 'image/png',
    width: 256,
    height: 256,
  };
}

describe('MessageBody', () => {
  it('applies the assistant bubble styling (no background)', () => {
    const { container } = render(
      <MessageBody variant="assistant" media={[]} contentKey={key} ariaPrefix="Generated" />
    );

    const bubble = container.firstElementChild;
    expect(bubble).toHaveClass('px-4', 'py-2', 'text-foreground', 'overflow-hidden');
    expect(bubble).not.toHaveClass('bg-message-user');
    expect(bubble).not.toHaveClass('bg-muted');
  });

  it('applies own-user bubble styling', () => {
    const { container } = render(
      <MessageBody variant="user-own" media={[]} contentKey={key} ariaPrefix="Generated" />
    );

    expect(container.firstElementChild).toHaveClass(
      'px-4',
      'py-2',
      'bg-message-user',
      'text-foreground',
      'rounded-lg'
    );
  });

  it('applies other-member bubble styling', () => {
    const { container } = render(
      <MessageBody variant="user-other" media={[]} contentKey={key} ariaPrefix="Generated" />
    );

    expect(container.firstElementChild).toHaveClass(
      'px-4',
      'py-2',
      'bg-muted',
      'text-foreground',
      'rounded-lg'
    );
  });

  it('marks the bubble as a reading surface so message text renders in the serif', () => {
    const { container } = render(
      <MessageBody variant="assistant" media={[]} contentKey={key} ariaPrefix="Generated" />
    );

    // data-reading is the twin of data-chrome: it flips the subtree to the serif
    // reading font. One tag here covers chat (MessageItem) and the public share view.
    expect(container.firstElementChild).toHaveAttribute('data-reading');
  });

  it('renders the text region (children) before the media list', () => {
    render(
      <MessageBody variant="assistant" media={[media('a')]} contentKey={key} ariaPrefix="Generated">
        <p data-testid="text-region">hello</p>
      </MessageBody>
    );

    const text = screen.getByTestId('text-region');
    const list = screen.getByTestId('media-list');
    expect(text).toBeInTheDocument();
    // DOM order: text region precedes media list.
    expect(text.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('forwards media, content key, and aria prefix to the media list', () => {
    render(
      <MessageBody
        variant="assistant"
        media={[media('a'), media('b')]}
        contentKey={key}
        ariaPrefix="Shared"
      />
    );

    const list = screen.getByTestId('media-list');
    expect(list).toHaveAttribute('data-count', '2');
    expect(list).toHaveAttribute('data-aria-prefix', 'Shared');
    expect(list).toHaveAttribute('data-has-key', 'yes');
  });

  it('forwards a content-key error to the media list', () => {
    render(
      <MessageBody
        variant="assistant"
        media={[media('a')]}
        contentKey={null}
        contentKeyError={new Error('Epoch key not available')}
        ariaPrefix="Generated"
      />
    );

    expect(screen.getByTestId('media-list')).toHaveAttribute(
      'data-key-error',
      'Epoch key not available'
    );
  });

  it('passes a null content-key error to the media list when none is supplied', () => {
    render(
      <MessageBody
        variant="assistant"
        media={[media('a')]}
        contentKey={key}
        ariaPrefix="Generated"
      />
    );

    expect(screen.getByTestId('media-list')).toHaveAttribute('data-key-error', 'none');
  });

  it('forwards an extra className onto the bubble', () => {
    const { container } = render(
      <MessageBody
        variant="assistant"
        media={[]}
        contentKey={key}
        ariaPrefix="Generated"
        className="custom-x"
      />
    );

    expect(container.firstElementChild).toHaveClass('custom-x');
  });
});
