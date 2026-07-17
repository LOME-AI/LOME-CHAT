import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { ShareButton } from './ShareButton';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ShareButton', () => {
  it('renders the idle "Copy link" label by default', () => {
    render(<ShareButton />);
    expect(screen.getByRole('button', { name: /copy link/i })).toBeInTheDocument();
  });

  it('copies the current page URL and flips to "Copied!" on click', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    render(<ShareButton />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();
    });
    expect(writeText).toHaveBeenCalledWith(globalThis.location.href);
  });

  it('reverts to "Copy link" after the 2s confirmation window', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    render(<ShareButton />);
    fireEvent.click(screen.getByRole('button'));

    // Flush the awaited clipboard microtask so setCopied(true) commits.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole('button', { name: /copy link/i })).toBeInTheDocument();
  });

  it('fails silently and stays idle when the clipboard API rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('insecure context'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    render(<ShareButton />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalled();
    });
    expect(screen.getByRole('button', { name: /copy link/i })).toBeInTheDocument();
  });
});
