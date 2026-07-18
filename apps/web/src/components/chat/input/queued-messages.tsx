import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUp, X } from 'lucide-react';
import { cn, IconButton, useReducedMotion } from '@hushbox/ui';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import type { QueuedMessage } from '@/stores/message-queue';

interface QueuedMessagesProps {
  /** Queued messages, oldest first: index 0 sends next and renders at the top. */
  queued: QueuedMessage[];
  /** Remove a queued message by id. */
  onCancel: (id: string) => void;
  /** Additional CSS classes for the container. */
  className?: string;
}

const MOTION_PROPS = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
  transition: { duration: 0.2, ease: 'easeOut' },
} as const;

/**
 * Presentational stack of pending-message pills shown directly above the
 * composer while a run streams. Purely prop-driven — it reads no store and
 * sends nothing; the queue store, composer, and drain wiring live elsewhere.
 */
export function QueuedMessages({
  queued,
  onCancel,
  className,
}: Readonly<QueuedMessagesProps>): React.JSX.Element | null {
  const animated = !useReducedMotion();

  if (queued.length === 0) {
    return null;
  }

  const motionProps = animated ? MOTION_PROPS : {};
  const noun = queued.length === 1 ? 'message' : 'messages';

  return (
    <div
      data-testid={TEST_IDS.queuedMessages}
      data-animated={String(animated)}
      className={cn('flex flex-col gap-1', className)}
    >
      <ul aria-label="Queued messages" className="flex flex-col gap-1">
        <AnimatePresence initial={false}>
          {queued.map((item, index) => (
            <motion.li
              key={item.id}
              {...motionProps}
              data-testid={TEST_ID_BUILDERS.queuedMessageItem(index)}
              className="overflow-hidden"
            >
              <div className="bg-muted/40 text-muted-foreground border-border flex items-center gap-2 rounded-full border px-3 py-1 text-sm">
                <ArrowUp className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span
                  title={item.text}
                  className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
                >
                  {item.text}
                </span>
                <IconButton
                  data-testid={TEST_ID_BUILDERS.queuedMessageCancel(index)}
                  aria-label={`Cancel queued message: ${item.text}`}
                  onClick={() => {
                    onCancel(item.id);
                  }}
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </IconButton>
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      <div role="status" aria-live="polite" className="sr-only">
        {`${String(queued.length)} ${noun} queued`}
      </div>
    </div>
  );
}
