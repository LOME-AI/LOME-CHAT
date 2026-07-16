import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { describeOpFields } from '@/lib/op-fields';
import { OpForm } from './op-form.js';

const WALLET_FIELDS = describeOpFields('wallet.credit', []);
const LOCK_FIELDS = describeOpFields('user.lock', []);
const UUID = '5b6a4a1e-7f4f-4bfb-9d5e-0a4c1d2e3f40';

describe('OpForm', () => {
  it('renders a labeled control per field with reason last', () => {
    render(<OpForm fields={WALLET_FIELDS} onSubmit={vi.fn()} />);
    const form = screen.getByTestId(TEST_IDS.adminOpForm);
    const inputs = form.querySelectorAll('input');
    expect(inputs).toHaveLength(3);
    expect(screen.getByLabelText('walletId')).toBeInTheDocument();
    expect(screen.getByLabelText('amountNanoUsd')).toBeInTheDocument();
    expect(screen.getByLabelText('reason')).toBeInTheDocument();
    expect([...inputs].at(-1)).toHaveAttribute('name', 'reason');
  });

  it('renders enum fields as a select with the contract options', async () => {
    const user = userEvent.setup();
    render(<OpForm fields={LOCK_FIELDS} onSubmit={vi.fn()} />);
    await user.click(screen.getByRole('combobox', { name: 'lockReason' }));
    expect(screen.getByRole('option', { name: 'chargeback' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'admin' })).toBeInTheDocument();
  });

  it('submits a selected enum value with the rest of the input', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<OpForm fields={LOCK_FIELDS} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText('userId'), UUID);
    await user.click(screen.getByRole('combobox', { name: 'lockReason' }));
    await user.click(screen.getByRole('option', { name: 'chargeback' }));
    await user.type(screen.getByLabelText('reason'), 'lock for dispute');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));

    expect(onSubmit).toHaveBeenCalledWith({
      userId: UUID,
      lockReason: 'chargeback',
      reason: 'lock for dispute',
    });
  });

  it('submits the built wire input', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<OpForm fields={WALLET_FIELDS} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText('walletId'), UUID);
    await user.type(screen.getByLabelText('amountNanoUsd'), '5000000000');
    await user.type(screen.getByLabelText('reason'), 'test credit');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));

    expect(onSubmit).toHaveBeenCalledWith({
      walletId: UUID,
      amountNanoUsd: '5000000000',
      reason: 'test credit',
    });
  });

  it('blocks submit and shows field errors for invalid values', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<OpForm fields={WALLET_FIELDS} onSubmit={onSubmit} />);

    await user.click(screen.getByRole('button', { name: 'Preview changes' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getAllByTestId(TEST_IDS.adminOpFieldError).length).toBeGreaterThan(0);
  });

  it('renders a number control and submits its value as a number', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <OpForm fields={[{ name: 'count', required: true, control: 'number' }]} onSubmit={onSubmit} />
    );
    const input = screen.getByLabelText('count');
    expect(input).toHaveAttribute('type', 'number');
    await user.type(input, '3');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(onSubmit).toHaveBeenCalledWith({ count: 3 });
  });

  it('renders an enum descriptor without options as an empty select', async () => {
    const user = userEvent.setup();
    render(
      <OpForm fields={[{ name: 'mode', required: true, control: 'enum' }]} onSubmit={vi.fn()} />
    );
    await user.click(screen.getByRole('combobox', { name: 'mode' }));
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('prefills initial values', () => {
    render(
      <OpForm
        fields={WALLET_FIELDS}
        initialValues={{ walletId: UUID, amountNanoUsd: '1', reason: 'undo' }}
        onSubmit={vi.fn()}
      />
    );
    expect(screen.getByLabelText('walletId')).toHaveValue(UUID);
    expect(screen.getByLabelText('reason')).toHaveValue('undo');
  });

  it('disables the submit button while pending', () => {
    render(<OpForm fields={WALLET_FIELDS} onSubmit={vi.fn()} pending />);
    expect(screen.getByRole('button', { name: 'Preview changes' })).toBeDisabled();
  });
});
