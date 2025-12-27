'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';

import { cn } from '../lib/utils';

interface ModalOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
}

/**
 * Reusable modal overlay component with blur backdrop.
 * Centers content on screen with click-outside-to-close and Escape key support.
 */
function ModalOverlay({
  open,
  onOpenChange,
  children,
  className,
}: ModalOverlayProps): React.JSX.Element {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-slot="modal-overlay-backdrop"
          data-testid="modal-overlay-backdrop"
          className={cn(
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'fixed inset-0 z-50 bg-black/50 backdrop-blur-sm'
          )}
        />
        <DialogPrimitive.Content
          data-slot="modal-overlay-content"
          data-testid="modal-overlay-content"
          className={cn(
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
            'fixed top-[50%] left-[50%] z-50 translate-x-[-50%] translate-y-[-50%] outline-none',
            className
          )}
        >
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export { ModalOverlay };
export type { ModalOverlayProps };
