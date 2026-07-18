import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';

import { useReducedMotion } from '../hooks/use-reduced-motion';

interface AnimatedHeightProps {
  children: React.ReactNode;
}

/**
 * Wraps conditional children with a height/opacity drop-down transition, used to
 * reveal inline detail content without layout shift. Self-safe for reduced
 * motion: it honors the merged reduced-motion signal internally (OS
 * `prefers-reduced-motion` OR the a11y widget's "stop animations") rather than
 * depending on a global `MotionConfig`, so it collapses to an instant render in
 * apps that do not wrap one. `data-animated` reflects the reduced state for test
 * and e2e determinism.
 */
export function AnimatedHeight({ children }: Readonly<AnimatedHeightProps>): React.JSX.Element {
  const animated = !useReducedMotion();
  if (!animated) {
    return (
      <div data-animated="false" className="overflow-hidden">
        {children}
      </div>
    );
  }
  return (
    <AnimatePresence mode="wait">
      {children ? (
        <motion.div
          data-animated="true"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeInOut' }}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
