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

  it('never wraps the id mid-string and exposes the full value as a title', () => {
    render(<CopyableId value="018f6b3a-0000-7000-8000-000000000002" label="job id" />);

    const id = screen.getByText('018f6b3a-0000-7000-8000-000000000002');
    expect(id).toHaveAttribute('title', '018f6b3a-0000-7000-8000-000000000002');
    expect(id.className).toContain('whitespace-nowrap');
    expect(id.className).not.toContain('break-all');
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
