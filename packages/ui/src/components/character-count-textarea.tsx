import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';

import { useReducedMotion } from '../hooks/use-reduced-motion';
import { cn } from '../lib/utilities';
import { Textarea } from './textarea';

interface CharacterCountTextareaProps extends Omit<React.ComponentProps<'textarea'>, 'maxLength'> {
  /** Current textarea value (controlled). */
  value: string;
  /** Soft character limit — never enforced natively; drives the counter and notice. */
  limit: number;
}

/**
 * A controlled textarea with an always-soft character limit: typing is never
 * blocked (no native `maxLength`). A live counter turns destructive at or over
 * the limit, and an over-limit polite live region announces that only the first
 * `limit` characters will be used. Callers truncate to `limit` on submit.
 */
export function CharacterCountTextarea({
  value,
  limit,
  className,
  'aria-describedby': ariaDescribedBy,
  ...props
}: Readonly<CharacterCountTextareaProps>): React.JSX.Element {
  const count = value.length;
  const isOver = count > limit;
  const counterId = React.useId();
  const noticeId = React.useId();
  // Honors the merged reduced-motion signal (OS `prefers-reduced-motion` OR the
  // a11y widget's "stop animations"). When reduced, the notice fades in place
  // without the vertical slide. The counter is static and never moves.
  const animated = !useReducedMotion();

  const describedBy = [ariaDescribedBy, counterId, isOver ? noticeId : undefined]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="space-y-1">
      <Textarea
        value={value}
        aria-describedby={describedBy}
        className={cn('max-h-72 min-h-32 resize-none overflow-y-auto', className)}
        {...props}
      />
      <div className="flex items-start justify-between gap-2 text-xs">
        {/* The notice rides its own clipped lane so its vertical slide is
            revealed within this row and never overlaps the textarea above. */}
        <div className="min-w-0 overflow-hidden">
          <AnimatePresence initial={false}>
            {isOver ? (
              <motion.p
                key="notice"
                id={noticeId}
                aria-live="polite"
                data-animated={String(animated)}
                className="text-destructive"
                initial={animated ? { opacity: 0, y: '-100%' } : { opacity: 0 }}
                animate={{ opacity: 1, y: 0 }}
                exit={animated ? { opacity: 0, y: '-100%' } : { opacity: 0 }}
                transition={{ type: 'spring', stiffness: 500, damping: 40 }}
              >
                Only the first {limit.toLocaleString()} characters will be used.
              </motion.p>
            ) : null}
          </AnimatePresence>
        </div>
        <p
          id={counterId}
          className={cn(
            'shrink-0 tabular-nums',
            isOver ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {count.toLocaleString()} / {limit.toLocaleString()}
        </p>
      </div>
    </div>
  );
}
