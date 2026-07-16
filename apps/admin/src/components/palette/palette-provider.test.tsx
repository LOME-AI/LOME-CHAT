import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PaletteProvider, usePalette } from './palette-provider.js';

function Probe(): React.JSX.Element {
  const { open, setOpen } = usePalette();
  return (
    <div>
      <span>{open ? 'open' : 'closed'}</span>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open palette
      </button>
    </div>
  );
}

describe('PaletteProvider', () => {
  it('starts closed and opens through the context setter', async () => {
    const user = userEvent.setup();
    render(
      <PaletteProvider>
        <Probe />
      </PaletteProvider>
    );
    expect(screen.getByText('closed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open palette' }));
    expect(screen.getByText('open')).toBeInTheDocument();
  });

  it.each([
    ['metaKey', { metaKey: true }],
    ['ctrlKey', { ctrlKey: true }],
  ])('toggles on %s+K', (_label, modifier) => {
    render(
      <PaletteProvider>
        <Probe />
      </PaletteProvider>
    );
    fireEvent.keyDown(document, { key: 'k', ...modifier });
    expect(screen.getByText('open')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'k', ...modifier });
    expect(screen.getByText('closed')).toBeInTheDocument();
  });

  it('ignores a bare k keypress', () => {
    render(
      <PaletteProvider>
        <Probe />
      </PaletteProvider>
    );
    fireEvent.keyDown(document, { key: 'k' });
    expect(screen.getByText('closed')).toBeInTheDocument();
  });

  it('throws when used outside the provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/PaletteProvider/);
    spy.mockRestore();
  });
});
