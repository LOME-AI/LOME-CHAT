import * as React from 'react';
import { render, screen, act, cleanup } from '@testing-library/react';
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
  // The identity of the appearance is what the frame's restyle is keyed on, so
  // counting the times it changes is counting the restyles a frame would get.
  const [changes, setChanges] = React.useState(0);
  React.useEffect(() => {
    setChanges((count) => count + 1);
  }, [appearance]);
  return (
    <>
      <output>{JSON.stringify(appearance)}</output>
      <data value={changes}>changes</data>
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

/**
 * Mount, then let the hook's observer deliver whatever the mount itself changed.
 * That delivery is a microtask, so without draining it here it would land after
 * the test body and update a still-mounted component outside `act`.
 */
async function renderProbe(): Promise<void> {
  render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>
  );
  await act(async () => {});
}

function appearance(): unknown {
  return JSON.parse(screen.getByRole('status').textContent);
}

/** How many distinct appearances the hook has produced so far. */
function changeCount(): number {
  return Number(screen.getByText('changes').getAttribute('value'));
}

/**
 * Exactly what the accessibility provider does when a tier is picked: it toggles
 * a class on the root element from an effect of its own. Driving the class
 * rather than the store is what keeps this test on the mechanism the frame
 * actually has to notice.
 */
async function applyContrastTier(className: string): Promise<void> {
  await act(async () => {
    document.documentElement.classList.add(className);
    await Promise.resolve();
  });
}

describe('useFrameAppearance', () => {
  afterEach(() => {
    // Unmount before the page is stripped: the hook watches the root element,
    // so tearing the stylesheet out from under a live component would fire its
    // observer outside `act`.
    cleanup();
    for (const style of document.querySelectorAll('style[data-tokens]')) style.remove();
    document.documentElement.className = '';
    localStorage.clear();
  });

  it('states the colour scheme the app is showing', async () => {
    await renderProbe();

    expect(appearance()).toMatchObject({ theme: 'light' });
  });

  it('resolves the app background and foreground tokens', async () => {
    stubTokens(REAL_TOKENS);
    await renderProbe();

    expect(appearance()).toEqual({
      theme: 'light',
      background: '#faf9f6',
      foreground: '#1a1a1a',
    });
  });

  it('follows the app to the other theme, colours and all', async () => {
    stubTokens(REAL_TOKENS);
    const user = userEvent.setup();
    await renderProbe();

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
  it('leaves out a token the wire cannot carry', async () => {
    stubTokens(':root { --background: oklch(0.98 0.01 90); --foreground: #1a1a1a; }');
    await renderProbe();

    expect(appearance()).toEqual({ theme: 'light', foreground: '#1a1a1a' });
  });

  it('leaves out a token the page does not define', async () => {
    await renderProbe();

    expect(appearance()).toEqual({ theme: 'light' });
  });

  // The accessibility contrast tiers move these same two tokens without moving
  // the theme, so a reader on a high-contrast tier would otherwise be left with
  // a document canvas that no longer matches the panel around it.
  it('follows a contrast tier that moves the tokens under an unchanged theme', async () => {
    stubTokens(`${REAL_TOKENS}
      html.a11y-contrast-high { --background: #ffffff; --foreground: #000000; }`);
    await renderProbe();
    expect(appearance()).toEqual({
      theme: 'light',
      background: '#faf9f6',
      foreground: '#1a1a1a',
    });

    await applyContrastTier('a11y-contrast-high');

    expect(appearance()).toEqual({
      theme: 'light',
      background: '#ffffff',
      foreground: '#000000',
    });
  });

  it('leaves the appearance alone when a root change moves neither token', async () => {
    stubTokens(REAL_TOKENS);
    await renderProbe();
    const before = appearance();

    await applyContrastTier('a11y-focus-visible');

    expect(appearance()).toEqual(before);
    // The value pin, not just the text: an appearance rebuilt from an unchanged
    // read would restyle the frame for nothing.
    expect(changeCount()).toBe(1);
  });

  it('produces one appearance for a tier change, not one per value it moved', async () => {
    stubTokens(`${REAL_TOKENS}
      html.a11y-contrast-high { --background: #ffffff; --foreground: #000000; }`);
    await renderProbe();

    await applyContrastTier('a11y-contrast-high');

    expect(changeCount()).toBe(2);
  });
});
