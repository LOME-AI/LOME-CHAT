import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { CopyableId } from './copyable-id.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CopyableId', () => {
  it('renders the id in monospace with a labeled copy button', () => {
    render(<CopyableId value="018f-abc" label="user id" />);

    expect(screen.getByText('018f-abc')).toHaveClass('font-mono');
    expect(screen.getByRole('button', { name: 'Copy user id' })).toBeInTheDocument();
  });

  it('copies the exact value to the clipboard', async () => {
    const user = userEvent.setup();
    // After setup(): userEvent installs its own clipboard stub this replaces.
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(<CopyableId value="raw-wire-value" label="amount" />);

    await user.click(screen.getByTestId(TEST_IDS.adminCopyId));

    expect(writeText).toHaveBeenCalledWith('raw-wire-value');
  });
});
