import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { describeOpFields } from '@/lib/op-fields';
import { OpForm } from './op-form.js';

const WALLET_FIELDS = describeOpFields('wallet.credit', []);
const LOCK_FIELDS = describeOpFields('user.lock', []);
const BANNER_FIELDS = describeOpFields('banner.set', []);
const UUID = '5b6a4a1e-7f4f-4bfb-9d5e-0a4c1d2e3f40';

function messageRow(index: number): HTMLElement {
  return screen.getByTestId(TEST_ID_BUILDERS.adminOpGroupRow('messages', index));
}

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

  it('renders a boolean field as a labeled switch that is off by default', () => {
    render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);
    const toggle = screen.getByRole('switch', { name: 'enabled' });
    expect(toggle).toHaveAttribute('data-testid', TEST_ID_BUILDERS.adminOpBooleanToggle('enabled'));
    expect(toggle).toHaveAttribute('data-state', 'unchecked');
  });

  it('toggles a boolean field and submits it as true', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={onSubmit} />);

    await user.click(screen.getByRole('switch', { name: 'enabled' }));
    await user.type(screen.getByLabelText('reason'), 'toggle banner');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));

    expect(onSubmit).toHaveBeenCalledWith({ enabled: true, messages: [], reason: 'toggle banner' });
  });

  it('renders a group with exactly one trailing empty row', () => {
    render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);
    expect(screen.getByTestId(TEST_ID_BUILDERS.adminOpGroup('messages'))).toBeInTheDocument();
    expect(messageRow(0)).toBeInTheDocument();
    expect(
      screen.queryByTestId(TEST_ID_BUILDERS.adminOpGroupRow('messages', 1))
    ).not.toBeInTheDocument();
  });

  it('grows a new trailing empty row when the user types into the last row', async () => {
    const user = userEvent.setup();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);

    await user.type(within(messageRow(0)).getByLabelText('text'), 'First message');

    expect(messageRow(1)).toBeInTheDocument();
    expect(within(messageRow(1)).getByLabelText('text')).toHaveValue('');
  });

  it('shows a delete button on filled rows but not the trailing empty row', async () => {
    const user = userEvent.setup();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);

    await user.type(within(messageRow(0)).getByLabelText('text'), 'First message');

    expect(
      screen.getByTestId(TEST_ID_BUILDERS.adminOpGroupRowDelete('messages', 0))
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId(TEST_ID_BUILDERS.adminOpGroupRowDelete('messages', 1))
    ).not.toBeInTheDocument();
  });

  it('removes a row when its delete button is clicked', async () => {
    const user = userEvent.setup();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);

    await user.type(within(messageRow(0)).getByLabelText('text'), 'Doomed row');
    await user.click(screen.getByRole('button', { name: 'Remove messages row 1' }));

    expect(within(messageRow(0)).getByLabelText('text')).toHaveValue('');
    expect(
      screen.queryByTestId(TEST_ID_BUILDERS.adminOpGroupRow('messages', 1))
    ).not.toBeInTheDocument();
  });

  it('submits group rows as the exact contract payload, dropping the trailing empty row', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={onSubmit} />);

    await user.click(screen.getByRole('switch', { name: 'enabled' }));
    await user.click(within(messageRow(0)).getByRole('combobox', { name: 'variant' }));
    await user.click(screen.getByRole('option', { name: 'warning' }));
    await user.type(within(messageRow(0)).getByLabelText('text'), 'Maintenance at noon');
    await user.type(within(messageRow(0)).getByLabelText('href'), 'https://status.hushbox.ai');
    await user.type(screen.getByLabelText('reason'), 'announce maintenance');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));

    expect(onSubmit).toHaveBeenCalledWith({
      enabled: true,
      messages: [
        { variant: 'warning', text: 'Maintenance at noon', href: 'https://status.hushbox.ai' },
      ],
      reason: 'announce maintenance',
    });
  });

  it('shows per-sub-field errors for a partially filled row instead of dropping it', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={onSubmit} />);

    await user.click(within(messageRow(0)).getByRole('combobox', { name: 'variant' }));
    await user.click(screen.getByRole('option', { name: 'info' }));
    await user.type(screen.getByLabelText('reason'), 'partial row');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(within(messageRow(0)).getByTestId(TEST_IDS.adminOpFieldError)).toHaveTextContent(
      'This field is required.'
    );
  });

  it('moves a row up, swapping full row values, and submits the new order', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={onSubmit} />);

    await user.type(within(messageRow(0)).getByLabelText('text'), 'First');
    await user.click(within(messageRow(0)).getByRole('combobox', { name: 'variant' }));
    await user.click(screen.getByRole('option', { name: 'info' }));
    await user.type(within(messageRow(1)).getByLabelText('text'), 'Second');
    await user.click(within(messageRow(1)).getByRole('combobox', { name: 'variant' }));
    await user.click(screen.getByRole('option', { name: 'warning' }));
    await user.click(screen.getByRole('button', { name: 'Move messages row 2 up' }));

    expect(within(messageRow(0)).getByLabelText('text')).toHaveValue('Second');
    expect(within(messageRow(1)).getByLabelText('text')).toHaveValue('First');

    await user.type(screen.getByLabelText('reason'), 'reorder');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(onSubmit).toHaveBeenCalledWith({
      enabled: false,
      messages: [
        { variant: 'warning', text: 'Second' },
        { variant: 'info', text: 'First' },
      ],
      reason: 'reorder',
    });
  });

  it('moves a row down, swapping full row values', async () => {
    const user = userEvent.setup();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);

    await user.type(within(messageRow(0)).getByLabelText('text'), 'First');
    await user.type(within(messageRow(1)).getByLabelText('text'), 'Second');
    await user.click(screen.getByRole('button', { name: 'Move messages row 1 down' }));

    expect(within(messageRow(0)).getByLabelText('text')).toHaveValue('Second');
    expect(within(messageRow(1)).getByLabelText('text')).toHaveValue('First');
  });

  it('disables move up on the first row and move down on the last filled row', async () => {
    const user = userEvent.setup();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);

    await user.type(within(messageRow(0)).getByLabelText('text'), 'First');
    await user.type(within(messageRow(1)).getByLabelText('text'), 'Second');

    expect(
      screen.getByTestId(TEST_ID_BUILDERS.adminOpGroupRowMoveUp('messages', 0))
    ).toBeDisabled();
    expect(
      screen.getByTestId(TEST_ID_BUILDERS.adminOpGroupRowMoveDown('messages', 0))
    ).toBeEnabled();
    expect(screen.getByTestId(TEST_ID_BUILDERS.adminOpGroupRowMoveUp('messages', 1))).toBeEnabled();
    expect(
      screen.getByTestId(TEST_ID_BUILDERS.adminOpGroupRowMoveDown('messages', 1))
    ).toBeDisabled();
  });

  it('renders no move controls on the trailing empty row', async () => {
    const user = userEvent.setup();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);

    await user.type(within(messageRow(0)).getByLabelText('text'), 'First');

    expect(
      screen.queryByTestId(TEST_ID_BUILDERS.adminOpGroupRowMoveUp('messages', 1))
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(TEST_ID_BUILDERS.adminOpGroupRowMoveDown('messages', 1))
    ).not.toBeInTheDocument();
  });

  it('prepends an empty row, shifting existing rows down intact, and focuses its first control', async () => {
    const user = userEvent.setup();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);

    await user.type(within(messageRow(0)).getByLabelText('text'), 'First');
    await user.click(screen.getByRole('button', { name: 'Add messages row at the front' }));

    expect(within(messageRow(0)).getByLabelText('text')).toHaveValue('');
    expect(within(messageRow(1)).getByLabelText('text')).toHaveValue('First');
    // The row object's first sub-field control receives focus.
    expect(within(messageRow(0)).getByRole('combobox', { name: 'variant' })).toHaveFocus();
  });

  it('submits a typed-into prepended row first in the payload', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={onSubmit} />);

    await user.type(within(messageRow(0)).getByLabelText('text'), 'Old first');
    await user.click(within(messageRow(0)).getByRole('combobox', { name: 'variant' }));
    await user.click(screen.getByRole('option', { name: 'info' }));
    await user.click(screen.getByRole('button', { name: 'Add messages row at the front' }));
    await user.type(within(messageRow(0)).getByLabelText('text'), 'New first');
    await user.click(within(messageRow(0)).getByRole('combobox', { name: 'variant' }));
    await user.click(screen.getByRole('option', { name: 'warning' }));
    await user.type(screen.getByLabelText('reason'), 'prepend');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));

    expect(onSubmit).toHaveBeenCalledWith({
      enabled: false,
      messages: [
        { variant: 'warning', text: 'New first' },
        { variant: 'info', text: 'Old first' },
      ],
      reason: 'prepend',
    });
  });

  it('keeps a displayed row error on its row when the row moves', async () => {
    const user = userEvent.setup();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);

    // Row 0 valid, row 1 missing its required text — submit surfaces the error.
    await user.type(within(messageRow(0)).getByLabelText('text'), 'Valid');
    await user.click(within(messageRow(0)).getByRole('combobox', { name: 'variant' }));
    await user.click(screen.getByRole('option', { name: 'critical' }));
    await user.click(within(messageRow(1)).getByRole('combobox', { name: 'variant' }));
    await user.click(screen.getByRole('option', { name: 'info' }));
    await user.type(screen.getByLabelText('reason'), 'errors follow');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(within(messageRow(1)).getByTestId(TEST_IDS.adminOpFieldError)).toHaveTextContent(
      'This field is required.'
    );

    await user.click(screen.getByRole('button', { name: 'Move messages row 2 up' }));

    expect(within(messageRow(0)).getByTestId(TEST_IDS.adminOpFieldError)).toHaveTextContent(
      'This field is required.'
    );
    expect(within(messageRow(1)).queryByTestId(TEST_IDS.adminOpFieldError)).not.toBeInTheDocument();

    // And back down: the error rides the row in both directions.
    await user.click(screen.getByRole('button', { name: 'Move messages row 1 down' }));
    expect(within(messageRow(0)).queryByTestId(TEST_IDS.adminOpFieldError)).not.toBeInTheDocument();
    expect(within(messageRow(1)).getByTestId(TEST_IDS.adminOpFieldError)).toHaveTextContent(
      'This field is required.'
    );
  });

  it('keeps a displayed row error on its row when a row is prepended', async () => {
    const user = userEvent.setup();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);

    await user.click(within(messageRow(0)).getByRole('combobox', { name: 'variant' }));
    await user.click(screen.getByRole('option', { name: 'info' }));
    await user.type(screen.getByLabelText('reason'), 'errors follow');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(within(messageRow(0)).getByTestId(TEST_IDS.adminOpFieldError)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add messages row at the front' }));

    expect(within(messageRow(0)).queryByTestId(TEST_IDS.adminOpFieldError)).not.toBeInTheDocument();
    expect(within(messageRow(1)).getByTestId(TEST_IDS.adminOpFieldError)).toHaveTextContent(
      'This field is required.'
    );
  });

  it('reorders prefilled rows and submits them in the new order', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <OpForm
        fields={BANNER_FIELDS}
        initialValues={{
          enabled: true,
          messages: [
            { variant: 'info', text: 'A' },
            { variant: 'warning', text: 'B' },
          ],
          reason: 'undo',
        }}
        onSubmit={onSubmit}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Move messages row 1 down' }));
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));

    expect(onSubmit).toHaveBeenCalledWith({
      enabled: true,
      messages: [
        { variant: 'warning', text: 'B' },
        { variant: 'info', text: 'A' },
      ],
      reason: 'undo',
    });
  });

  it('reorders then prepends prefilled rows and submits the new order', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <OpForm
        fields={BANNER_FIELDS}
        initialValues={{
          enabled: true,
          messages: [
            { variant: 'warning', text: 'First', href: 'https://status.hushbox.ai', linkText: 'S' },
            { variant: 'critical', text: 'Edited' },
          ],
        }}
        onSubmit={onSubmit}
      />
    );

    // Move row 1 up (swaps the two filled rows).
    await user.click(screen.getByRole('button', { name: 'Move messages row 2 up' }));
    expect(within(messageRow(0)).getByLabelText('text')).toHaveValue('Edited');
    expect(within(messageRow(1)).getByLabelText('text')).toHaveValue('First');

    // Prepend a fresh row at the front and fill it.
    await user.click(screen.getByRole('button', { name: 'Add messages row at the front' }));
    await user.click(within(messageRow(0)).getByRole('combobox', { name: 'variant' }));
    await user.click(screen.getByRole('option', { name: 'info' }));
    await user.type(within(messageRow(0)).getByLabelText('text'), 'Third');

    expect(within(messageRow(0)).getByLabelText('text')).toHaveValue('Third');
    expect(within(messageRow(1)).getByLabelText('text')).toHaveValue('Edited');
    expect(within(messageRow(2)).getByLabelText('text')).toHaveValue('First');

    await user.type(screen.getByLabelText('reason'), 'reorder and prepend');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));

    expect(onSubmit).toHaveBeenCalledWith({
      enabled: true,
      messages: [
        { variant: 'info', text: 'Third' },
        { variant: 'critical', text: 'Edited' },
        { variant: 'warning', text: 'First', href: 'https://status.hushbox.ai', linkText: 'S' },
      ],
      reason: 'reorder and prepend',
    });
  });

  it('leaves an error on an unaffected row when other rows move', async () => {
    const user = userEvent.setup();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);

    // Rows 0 and 2 miss their required text; rows 1 and 2 then swap.
    await user.click(within(messageRow(0)).getByRole('combobox', { name: 'variant' }));
    await user.click(screen.getByRole('option', { name: 'info' }));
    await user.type(within(messageRow(1)).getByLabelText('text'), 'Valid');
    await user.click(within(messageRow(1)).getByRole('combobox', { name: 'variant' }));
    await user.click(screen.getByRole('option', { name: 'warning' }));
    await user.click(within(messageRow(2)).getByRole('combobox', { name: 'variant' }));
    await user.click(screen.getByRole('option', { name: 'critical' }));
    await user.type(screen.getByLabelText('reason'), 'unaffected row');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    await user.click(screen.getByRole('button', { name: 'Move messages row 3 up' }));

    expect(within(messageRow(0)).getByTestId(TEST_IDS.adminOpFieldError)).toBeInTheDocument();
    expect(within(messageRow(1)).getByTestId(TEST_IDS.adminOpFieldError)).toBeInTheDocument();
    expect(within(messageRow(2)).queryByTestId(TEST_IDS.adminOpFieldError)).not.toBeInTheDocument();
  });

  it('neither submits nor validates when a row delete button is clicked', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={onSubmit} />);

    await user.type(within(messageRow(0)).getByLabelText('text'), 'Doomed row');
    await user.click(screen.getByRole('button', { name: 'Remove messages row 1' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryAllByTestId(TEST_IDS.adminOpFieldError)).toHaveLength(0);
  });

  it('drops the deleted row errors and shifts later row errors down on delete', async () => {
    const user = userEvent.setup();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);

    // Row 0 misses variant (its error must stay put); row 1 misses text (its
    // error dies with it); row 2 misses variant (its error must follow the
    // row up to index 1).
    await user.type(within(messageRow(0)).getByLabelText('text'), 'Above');
    await user.click(within(messageRow(1)).getByRole('combobox', { name: 'variant' }));
    await user.click(screen.getByRole('option', { name: 'warning' }));
    await user.type(within(messageRow(2)).getByLabelText('text'), 'Keeper');
    await user.type(screen.getByLabelText('reason'), 'delete remap');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    await user.click(screen.getByRole('button', { name: 'Remove messages row 2' }));

    const aboveErrors = within(messageRow(0)).getAllByTestId(TEST_IDS.adminOpFieldError);
    expect(aboveErrors).toHaveLength(1);
    expect(aboveErrors[0]?.parentElement).toContainElement(
      within(messageRow(0)).getByLabelText('variant')
    );
    const keeperErrors = within(messageRow(1)).getAllByTestId(TEST_IDS.adminOpFieldError);
    expect(keeperErrors).toHaveLength(1);
    expect(keeperErrors[0]?.parentElement).toContainElement(
      within(messageRow(1)).getByLabelText('variant')
    );
    expect(within(messageRow(2)).queryByTestId(TEST_IDS.adminOpFieldError)).not.toBeInTheDocument();
  });

  it('renders a group descriptor without sub-fields as a bare empty row', () => {
    render(
      <OpForm fields={[{ name: 'rows', required: true, control: 'group' }]} onSubmit={vi.fn()} />
    );
    const row = screen.getByTestId(TEST_ID_BUILDERS.adminOpGroupRow('rows', 0));
    expect(row.querySelectorAll('input')).toHaveLength(0);
  });

  it('prepends on a group without sub-fields without moving focus', async () => {
    const user = userEvent.setup();
    render(
      <OpForm fields={[{ name: 'rows', required: true, control: 'group' }]} onSubmit={vi.fn()} />
    );

    await user.click(screen.getByRole('button', { name: 'Add rows row at the front' }));

    // No first control exists to focus; the empty rows still stack up.
    expect(screen.getByTestId(TEST_ID_BUILDERS.adminOpGroupRow('rows', 1))).toBeInTheDocument();
  });

  it('treats a group-shaped initial value on a scalar field as untouched', () => {
    render(
      <OpForm
        fields={[{ name: 'note', required: false, control: 'text' }]}
        initialValues={{ note: [] }}
        onSubmit={vi.fn()}
      />
    );
    expect(screen.getByLabelText('note')).toHaveValue('');
  });

  it('prefills group rows and booleans from initial values', () => {
    render(
      <OpForm
        fields={BANNER_FIELDS}
        initialValues={{
          enabled: true,
          messages: [{ variant: 'info', text: 'Restored', href: '' }],
          reason: 'undo',
        }}
        onSubmit={vi.fn()}
      />
    );
    expect(screen.getByRole('switch', { name: 'enabled' })).toHaveAttribute(
      'data-state',
      'checked'
    );
    expect(within(messageRow(0)).getByLabelText('text')).toHaveValue('Restored');
    // The prefilled list still gets its trailing empty row.
    expect(within(messageRow(1)).getByLabelText('text')).toHaveValue('');
  });
});
