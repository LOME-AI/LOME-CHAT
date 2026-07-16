import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { DiffList } from './diff-list.js';

describe('DiffList', () => {
  it('renders a before to after row per effect', () => {
    render(
      <DiffList effects={[{ label: 'wallet.balanceNanoUsd', before: '1000', after: '6000' }]} />
    );
    const list = screen.getByTestId(TEST_IDS.adminOpDiff);
    const row = within(list).getByText('wallet.balanceNanoUsd').closest('li');
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent('1000');
    expect(row).toHaveTextContent('6000');
  });

  it('marks an effect without a before value as an addition', () => {
    render(<DiffList effects={[{ label: 'ledger.leg', after: 'credit' }]} />);
    const row = screen.getByText('ledger.leg').closest('li');
    expect(row).toHaveTextContent('added');
    expect(row).toHaveTextContent('credit');
  });

  it('renders object values as JSON', () => {
    render(<DiffList effects={[{ label: 'row', before: { a: 1 }, after: { a: 2 } }]} />);
    const row = screen.getByText('row').closest('li');
    expect(row).toHaveTextContent('{"a":1}');
    expect(row).toHaveTextContent('{"a":2}');
  });

  it('treats a null before value as an addition', () => {
    render(<DiffList effects={[{ label: 'row.created', before: null, after: 'x' }]} />);
    expect(screen.getByText('row.created').closest('li')).toHaveTextContent('added');
  });

  it('renders a removed after value as none', () => {
    render(<DiffList effects={[{ label: 'flag.cleared', before: 7 }]} />);
    const row = screen.getByText('flag.cleared').closest('li');
    expect(row).toHaveTextContent('7');
    expect(row).toHaveTextContent('none');
  });

  it('says so when the preview produced no changes', () => {
    render(<DiffList effects={[]} />);
    expect(screen.getByTestId(TEST_IDS.adminOpDiff)).toHaveTextContent('No changes.');
  });
});
