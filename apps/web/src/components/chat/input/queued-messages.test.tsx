import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import type { QueuedMessage } from '@/stores/message-queue';

const reducedMotionRef = { current: false };

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useReducedMotion: () => reducedMotionRef.current,
  };
});

import { QueuedMessages } from '@/components/chat/input/queued-messages';

function makeQueued(count: number): QueuedMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `id-${String(index)}`,
    text: `message ${String(index)}`,
  }));
}

describe('QueuedMessages', () => {
  beforeEach(() => {
    reducedMotionRef.current = false;
  });

  it('renders nothing when the queue is empty', () => {
    const { container } = render(<QueuedMessages queued={[]} onCancel={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId(TEST_IDS.queuedMessages)).not.toBeInTheDocument();
  });

  it('renders one pill per queued item in array order', () => {
    const queued: QueuedMessage[] = [
      { id: 'a', text: 'first' },
      { id: 'b', text: 'second' },
      { id: 'c', text: 'third' },
    ];
    render(<QueuedMessages queued={queued} onCancel={vi.fn()} />);

    const items = [0, 1, 2].map((index) =>
      screen.getByTestId(TEST_ID_BUILDERS.queuedMessageItem(index))
    );
    expect(items[0]).toHaveTextContent('first');
    expect(items[1]).toHaveTextContent('second');
    expect(items[2]).toHaveTextContent('third');
  });

  it('renders the container with the registry test id', () => {
    render(<QueuedMessages queued={makeQueued(1)} onCancel={vi.fn()} />);
    expect(screen.getByTestId(TEST_IDS.queuedMessages)).toBeInTheDocument();
  });

  it('truncates the message text on one line', () => {
    render(
      <QueuedMessages
        queued={[{ id: 'a', text: 'a very long queued message' }]}
        onCancel={vi.fn()}
      />
    );
    const text = screen.getByText('a very long queued message');
    expect(text).toHaveClass('whitespace-nowrap', 'overflow-hidden', 'text-ellipsis');
    expect(text).toHaveAttribute('title', 'a very long queued message');
  });

  it('calls onCancel with the item id when its cancel button is clicked', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const queued: QueuedMessage[] = [
      { id: 'a', text: 'first' },
      { id: 'b', text: 'second' },
    ];
    render(<QueuedMessages queued={queued} onCancel={onCancel} />);

    await user.click(screen.getByTestId(TEST_ID_BUILDERS.queuedMessageCancel(1)));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith('b');
  });

  it('labels each cancel button with the message text', () => {
    render(<QueuedMessages queued={[{ id: 'a', text: 'hello world' }]} onCancel={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: 'Cancel queued message: hello world' })
    ).toBeInTheDocument();
  });

  it('gives the list an accessible name', () => {
    render(<QueuedMessages queued={makeQueued(1)} onCancel={vi.fn()} />);
    expect(screen.getByRole('list', { name: 'Queued messages' })).toBeInTheDocument();
  });

  it('announces the queued count in a polite live region', () => {
    render(<QueuedMessages queued={makeQueued(2)} onCancel={vi.fn()} />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('2 messages queued');
  });

  it('announces the singular count for one queued message', () => {
    render(<QueuedMessages queued={makeQueued(1)} onCancel={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('1 message queued');
  });

  it('marks the container as animated when motion is allowed', () => {
    reducedMotionRef.current = false;
    render(<QueuedMessages queued={makeQueued(1)} onCancel={vi.fn()} />);
    expect(screen.getByTestId(TEST_IDS.queuedMessages)).toHaveAttribute('data-animated', 'true');
  });

  it('renders without motion driving animation under reduced motion', () => {
    reducedMotionRef.current = true;
    render(<QueuedMessages queued={makeQueued(2)} onCancel={vi.fn()} />);
    expect(screen.getByTestId(TEST_IDS.queuedMessages)).toHaveAttribute('data-animated', 'false');
    expect(screen.getByTestId(TEST_ID_BUILDERS.queuedMessageItem(0))).toBeInTheDocument();
    expect(screen.getByTestId(TEST_ID_BUILDERS.queuedMessageItem(1))).toBeInTheDocument();
  });

  it('applies the optional className to the container', () => {
    render(<QueuedMessages queued={makeQueued(1)} onCancel={vi.fn()} className="mt-2" />);
    expect(screen.getByTestId(TEST_IDS.queuedMessages)).toHaveClass('mt-2');
  });
});
