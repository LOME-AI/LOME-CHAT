'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { XIcon } from 'lucide-react';
import { TEST_IDS } from '@hushbox/shared';

import { cn } from '../lib/utilities';
import { OverlayNavButtons, CLOSE_BUTTON_CLASS } from './overlay-nav-buttons';
import type { OverlayProps } from './overlay';

/**
 * Dialog renderer for Overlay — centered modal with blur backdrop.
 * Used on desktop (non-touch) devices.
 */
function OverlayDialog({
  open,
  onOpenChange,
  children,
  className,
  ariaLabel,
  onOpenAutoFocus,
  showCloseButton = true,
  currentStep,
  onBack,
  dismissible = true,
}: Readonly<OverlayProps>): React.JSX.Element {
  const showBackButton = currentStep !== undefined && currentStep > 1 && onBack !== undefined;
  // When undismissible, suppress the close button entirely — leaving it visible
  // while it does nothing would be a UI lie.
  const renderCloseButton = showCloseButton && dismissible;

  const closeElement = renderCloseButton ? (
    <DialogPrimitive.Close data-slot="overlay-close" className={CLOSE_BUTTON_CLASS}>
      <XIcon />
      <span className="sr-only">Close</span>
    </DialogPrimitive.Close>
  ) : null;

  const preventDismiss = (event: Event): void => {
    if (!dismissible) event.preventDefault();
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-slot="overlay-backdrop"
          data-testid={TEST_IDS.overlayBackdrop}
          className={cn(
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'z-modal fixed inset-0 bg-black/50 backdrop-blur-sm'
          )}
        />
        <DialogPrimitive.Content
          data-slot="overlay-content"
          data-testid={TEST_IDS.overlayContent}
          data-overlay-variant="dialog"
          className={cn(
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
            // A fixed, translate-centered dialog cannot be window-scrolled, so it caps its
            // own height and scrolls internally — otherwise content taller than the
            // viewport pushes its actions off-screen unreachably.
            'z-modal fixed top-[50%] left-[50%] max-h-[calc(100dvh-2rem)] translate-x-[-50%] translate-y-[-50%] overflow-y-auto pt-2 outline-none',
            className
          )}
          aria-describedby={undefined}
          onOpenAutoFocus={onOpenAutoFocus}
          onEscapeKeyDown={preventDismiss}
          onPointerDownOutside={preventDismiss}
          onInteractOutside={preventDismiss}
        >
          <DialogPrimitive.Title className="sr-only">{ariaLabel}</DialogPrimitive.Title>
          <OverlayNavButtons
            showBackButton={showBackButton}
            onBack={onBack}
            closeElement={closeElement}
          />
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export { OverlayDialog };
