import { describe, it, expect, vi } from 'vitest';

// PaymentForm's real success path runs the full HelcimPay.js tokenization +
// polling flow (exercised in payment-form.test.tsx). Here we stub it to a pair
// of trigger buttons so PaymentModal's own onSuccess/onCancel forwarding is
// verified in isolation.
vi.mock('./payment-form', () => ({
  PaymentForm: ({
    onSuccess,
    onCancel,
  }: {
    onSuccess?: () => void;
    onCancel?: () => void;
  }): React.JSX.Element => (
    <div>
      <button type="button" onClick={() => onSuccess?.()}>
        trigger-success
      </button>
      <button type="button" onClick={() => onCancel?.()}>
        trigger-cancel
      </button>
    </div>
  ),
}));

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PaymentModal } from './payment-modal';

describe('PaymentModal success wiring', () => {
  it('forwards the payment form success to its own onSuccess prop', async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    render(<PaymentModal open={true} onOpenChange={vi.fn()} onSuccess={onSuccess} />);

    await user.click(screen.getByText('trigger-success'));

    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});
