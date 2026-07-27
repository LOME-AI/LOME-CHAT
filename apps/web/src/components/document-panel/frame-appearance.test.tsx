import * as React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, afterEach } from 'vitest';
import { ThemeProvider, useTheme } from '@/providers/theme-provider';
import { useFrameAppearance } from './frame-appearance';

/** Stands in for the app's stylesheet: the tokens the hook is asked to resolve. */
function stubTokens(css: string): void {
  const style = document.createElement('style');
  style.dataset['tokens'] = '';
  style.textContent = css;
  document.head.append(style);
}

const REAL_TOKENS = `
  :root { --background: #faf9f6; --foreground: #1a1a1a; }
  .dark { --background: #1a1816; --foreground: #f2f1ef; }
`;

function Probe(): React.JSX.Element {
  const appearance = useFrameAppearance();
  const { triggerTransition } = useTheme();
  return (
    <>
      <output>{JSON.stringify(appearance)}</output>
      <button
        type="button"
        onClick={() => {
          triggerTransition({ x: 0, y: 0 });
        }}
      >
        switch theme
      </button>
    </>
  );
}

function renderProbe(): void {
  render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>
  );
}

function appearance(): unknown {
  return JSON.parse(screen.getByRole('status').textContent);
}

describe('useFrameAppearance', () => {
  afterEach(() => {
    for (const style of document.querySelectorAll('style[data-tokens]')) style.remove();
    document.documentElement.className = '';
    localStorage.clear();
  });

  it('states the colour scheme the app is showing', () => {
    renderProbe();

    expect(appearance()).toMatchObject({ theme: 'light' });
  });

  it('resolves the app background and foreground tokens', () => {
    stubTokens(REAL_TOKENS);
    renderProbe();

    expect(appearance()).toEqual({
      theme: 'light',
      background: '#faf9f6',
      foreground: '#1a1a1a',
    });
  });

  it('follows the app to the other theme, colours and all', async () => {
    stubTokens(REAL_TOKENS);
    const user = userEvent.setup();
    renderProbe();

    await user.click(screen.getByRole('button', { name: 'switch theme' }));

    expect(appearance()).toEqual({
      theme: 'dark',
      background: '#1a1816',
      foreground: '#f2f1ef',
    });
  });

  // The frame validates the whole message and drops one that fails, so a colour
  // the wire cannot carry must be left out rather than sent — leaving it in
  // would take the document down with it.
  it('leaves out a token the wire cannot carry', () => {
    stubTokens(':root { --background: oklch(0.98 0.01 90); --foreground: #1a1a1a; }');
    renderProbe();

    expect(appearance()).toEqual({ theme: 'light', foreground: '#1a1a1a' });
  });

  it('leaves out a token the page does not define', () => {
    renderProbe();

    expect(appearance()).toEqual({ theme: 'light' });
  });
});
