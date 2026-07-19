import * as React from 'react';
import { cn } from '../lib/utilities';

const SIZE_MAP = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  full: 'max-w-4xl',
} as const;

export interface OverlayContentProps {
  children: React.ReactNode;
  /** Size variant controlling max-width. Defaults to 'md'. */
  size?: keyof typeof SIZE_MAP;
  className?: string;
  'data-testid'?: string;
}

export function OverlayContent({
  children,
  size = 'md',
  className,
  'data-testid': testId,
}: Readonly<OverlayContentProps>): React.JSX.Element {
  return (
    <div
      className={cn(
        // Cap height to the viewport and scroll internally so content taller than the
        // screen never pushes actions out of reach.
        'bg-background flex max-h-[calc(100dvh-2rem)] w-[90vw] flex-col gap-4 overflow-y-auto rounded-lg border p-6 shadow-lg',
        SIZE_MAP[size],
        className
      )}
      {...(testId !== undefined && { 'data-testid': testId })}
    >
      {children}
    </div>
  );
}
