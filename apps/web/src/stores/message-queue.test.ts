import { describe, it, expect, beforeEach } from 'vitest';
import { useMessageQueueStore } from './message-queue';

const CONV_A = 'conversation-a';
const CONV_B = 'conversation-b';

function fill(conversationId: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    useMessageQueueStore.getState().enqueue(conversationId, `message ${String(index)}`);
  }
}

describe('useMessageQueueStore', () => {
  beforeEach(() => {
    useMessageQueueStore.setState({ queuesByConversation: {} });
  });

  describe('enqueue', () => {
    it('appends a message with a fresh id and returns true', () => {
      const ok = useMessageQueueStore.getState().enqueue(CONV_A, 'hello');

      expect(ok).toBe(true);
      const items = useMessageQueueStore.getState().queued(CONV_A);
      expect(items).toHaveLength(1);
      expect(items[0]!.text).toBe('hello');
      expect(typeof items[0]!.id).toBe('string');
      expect(items[0]!.id.length).toBeGreaterThan(0);
    });

    it('mints a distinct id per enqueued message', () => {
      useMessageQueueStore.getState().enqueue(CONV_A, 'first');
      useMessageQueueStore.getState().enqueue(CONV_A, 'second');

      const [a, b] = useMessageQueueStore.getState().queued(CONV_A);
      expect(a!.id).not.toBe(b!.id);
    });

    it('preserves FIFO order (newest at the end)', () => {
      useMessageQueueStore.getState().enqueue(CONV_A, 'first');
      useMessageQueueStore.getState().enqueue(CONV_A, 'second');

      const items = useMessageQueueStore.getState().queued(CONV_A);
      expect(items.map((m) => m.text)).toEqual(['first', 'second']);
    });

    it('accepts up to five messages, all returning true', () => {
      const results = Array.from({ length: 5 }, (_, index) =>
        useMessageQueueStore.getState().enqueue(CONV_A, `message ${String(index)}`)
      );

      expect(results).toEqual([true, true, true, true, true]);
      expect(useMessageQueueStore.getState().count(CONV_A)).toBe(5);
    });

    it('rejects the sixth message, returning false and leaving the queue at five', () => {
      fill(CONV_A, 5);

      const sixth = useMessageQueueStore.getState().enqueue(CONV_A, 'overflow');

      expect(sixth).toBe(false);
      expect(useMessageQueueStore.getState().count(CONV_A)).toBe(5);
      expect(
        useMessageQueueStore
          .getState()
          .queued(CONV_A)
          .some((m) => m.text === 'overflow')
      ).toBe(false);
    });
  });

  describe('cancel', () => {
    it('removes the item with the given id', () => {
      useMessageQueueStore.getState().enqueue(CONV_A, 'keep');
      useMessageQueueStore.getState().enqueue(CONV_A, 'drop');
      const dropId = useMessageQueueStore.getState().queued(CONV_A)[1]!.id;

      useMessageQueueStore.getState().cancel(CONV_A, dropId);

      const items = useMessageQueueStore.getState().queued(CONV_A);
      expect(items).toHaveLength(1);
      expect(items[0]!.text).toBe('keep');
    });

    it('is a no-op for an unknown id', () => {
      useMessageQueueStore.getState().enqueue(CONV_A, 'keep');

      useMessageQueueStore.getState().cancel(CONV_A, 'does-not-exist');

      expect(useMessageQueueStore.getState().count(CONV_A)).toBe(1);
    });

    it('is a no-op for a conversation with no queue', () => {
      useMessageQueueStore.getState().cancel(CONV_A, 'anything');

      expect(useMessageQueueStore.getState().count(CONV_A)).toBe(0);
    });
  });

  describe('dequeueHead', () => {
    it('removes and returns the oldest item', () => {
      useMessageQueueStore.getState().enqueue(CONV_A, 'oldest');
      useMessageQueueStore.getState().enqueue(CONV_A, 'newest');

      const head = useMessageQueueStore.getState().dequeueHead(CONV_A);

      expect(head?.text).toBe('oldest');
      const remaining = useMessageQueueStore.getState().queued(CONV_A);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.text).toBe('newest');
    });

    it('returns undefined when the queue is empty', () => {
      const head = useMessageQueueStore.getState().dequeueHead(CONV_A);

      expect(head).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('empties the given conversation queue', () => {
      fill(CONV_A, 3);

      useMessageQueueStore.getState().clear(CONV_A);

      expect(useMessageQueueStore.getState().count(CONV_A)).toBe(0);
    });
  });

  describe('conversation isolation', () => {
    it('enqueue on one conversation does not touch another', () => {
      useMessageQueueStore.getState().enqueue(CONV_A, 'for a');
      useMessageQueueStore.getState().enqueue(CONV_B, 'for b');

      expect(
        useMessageQueueStore
          .getState()
          .queued(CONV_A)
          .map((m) => m.text)
      ).toEqual(['for a']);
      expect(
        useMessageQueueStore
          .getState()
          .queued(CONV_B)
          .map((m) => m.text)
      ).toEqual(['for b']);
    });

    it('cancel on one conversation does not touch another', () => {
      useMessageQueueStore.getState().enqueue(CONV_A, 'for a');
      useMessageQueueStore.getState().enqueue(CONV_B, 'for b');
      const idA = useMessageQueueStore.getState().queued(CONV_A)[0]!.id;

      useMessageQueueStore.getState().cancel(CONV_A, idA);

      expect(useMessageQueueStore.getState().count(CONV_A)).toBe(0);
      expect(useMessageQueueStore.getState().count(CONV_B)).toBe(1);
    });

    it('clear on one conversation only empties that conversation', () => {
      fill(CONV_A, 2);
      fill(CONV_B, 2);

      useMessageQueueStore.getState().clear(CONV_A);

      expect(useMessageQueueStore.getState().count(CONV_A)).toBe(0);
      expect(useMessageQueueStore.getState().count(CONV_B)).toBe(2);
    });
  });

  describe('selectors', () => {
    it('queued returns an empty array for an untouched conversation', () => {
      expect(useMessageQueueStore.getState().queued(CONV_A)).toEqual([]);
    });

    it('count reflects the number of queued messages', () => {
      expect(useMessageQueueStore.getState().count(CONV_A)).toBe(0);
      fill(CONV_A, 2);
      expect(useMessageQueueStore.getState().count(CONV_A)).toBe(2);
    });

    it('isFull is false below the cap and true at the cap', () => {
      expect(useMessageQueueStore.getState().isFull(CONV_A)).toBe(false);
      fill(CONV_A, 5);
      expect(useMessageQueueStore.getState().isFull(CONV_A)).toBe(true);
    });
  });
});
