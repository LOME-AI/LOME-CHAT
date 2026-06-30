import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { LegacyContentKey } from '@hushbox/crypto';
import type { RenderableMedia } from '@/components/chat/media/media-content-item';

vi.mock('@/components/chat/media/media-content-item', () => ({
  MediaContentItem: ({
    item,
    contentKey,
    contentKeyError,
    ariaPrefix,
  }: {
    item: RenderableMedia;
    contentKey: LegacyContentKey | null;
    contentKeyError?: Error | null;
    ariaPrefix: string;
  }) => (
    <div
      data-testid={`media-${item.contentItemId}`}
      data-aria-prefix={ariaPrefix}
      data-has-key={contentKey === null ? 'no' : 'yes'}
      data-key-error={contentKeyError ? contentKeyError.message : 'none'}
    />
  ),
}));

import { MessageMediaList } from '@/components/chat/message/message-media-list';

const key = new Uint8Array([1, 2, 3]) as LegacyContentKey;

function media(contentItemId: string, overrides: Partial<RenderableMedia> = {}): RenderableMedia {
  return {
    contentItemId,
    contentType: 'image',
    mimeType: 'image/png',
    width: 256,
    height: 256,
    ...overrides,
  };
}

describe('MessageMediaList', () => {
  it('renders nothing when there are no media items', () => {
    const { container } = render(
      <MessageMediaList media={[]} contentKey={key} ariaPrefix="Generated" />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('renders one MediaContentItem per media item, preserving order', () => {
    render(
      <MessageMediaList
        media={[media('a'), media('b'), media('c')]}
        contentKey={key}
        ariaPrefix="Generated"
      />
    );

    const ids = [...document.querySelectorAll<HTMLElement>('[data-testid^="media-"]')].map(
      (el) => el.dataset['testid']
    );
    expect(ids).toEqual(['media-a', 'media-b', 'media-c']);
  });

  it('stacks items in the same spacing container the chat bubble uses', () => {
    render(<MessageMediaList media={[media('a')]} contentKey={key} ariaPrefix="Generated" />);

    const wrapper = screen.getByTestId('media-a').parentElement;
    expect(wrapper).toHaveClass('mt-2', 'flex', 'flex-col', 'gap-2');
  });

  it('forwards the content key and aria prefix to each item', () => {
    render(<MessageMediaList media={[media('a')]} contentKey={key} ariaPrefix="Shared" />);

    const item = screen.getByTestId('media-a');
    expect(item).toHaveAttribute('data-aria-prefix', 'Shared');
    expect(item).toHaveAttribute('data-has-key', 'yes');
  });

  it('passes a null content key through (still resolving upstream)', () => {
    render(<MessageMediaList media={[media('a')]} contentKey={null} ariaPrefix="Generated" />);

    expect(screen.getByTestId('media-a')).toHaveAttribute('data-has-key', 'no');
    expect(screen.getByTestId('media-a')).toHaveAttribute('data-key-error', 'none');
  });

  it('forwards a content-key error to each item so undecryptable media shows an error (H11)', () => {
    render(
      <MessageMediaList
        media={[media('a'), media('b')]}
        contentKey={null}
        contentKeyError={new Error('Epoch key not available')}
        ariaPrefix="Generated"
      />
    );

    expect(screen.getByTestId('media-a')).toHaveAttribute(
      'data-key-error',
      'Epoch key not available'
    );
    expect(screen.getByTestId('media-b')).toHaveAttribute(
      'data-key-error',
      'Epoch key not available'
    );
  });
});
