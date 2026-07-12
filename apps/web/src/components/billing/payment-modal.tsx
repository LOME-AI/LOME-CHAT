import * as React from 'react';
import { Overlay, useIsMobile } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { PaymentForm } from './payment-form';

interface PaymentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function PaymentModal({
  open,
  onOpenChange,
  onSuccess,
}: Readonly<PaymentModalProps>): React.JSX.Element | null {
  const isMobile = useIsMobile();

  const handleSuccess = (): void => {
    onSuccess();
  };

  const handleCancel = (): void => {
    onOpenChange(false);
  };

  // Prevent auto-focus on mobile to avoid triggering keyboard
  const handleOpenAutoFocus = React.useCallback(
    (event: Event) => {
      if (isMobile) {
        event.preventDefault();
      }
    },
    [isMobile]
  );

  if (!open) return null;

  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="Add credits"
      onOpenAutoFocus={handleOpenAutoFocus}
    >
      <div data-testid={TEST_IDS.paymentModal}>
        <PaymentForm onSuccess={handleSuccess} onCancel={handleCancel} />
      </div>
    </Overlay>
  );
}
