import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vaul's real Drawer defers mounting its content subtree past the first commit,
// so the component's `contentRef` is still null when its focus-scroll effect
// runs and the listener never attaches — leaving the effect unexercisable
// through the real drawer. Mocking vaul (a true external UI seam) to render its
// content synchronously lets `contentRef` populate on the first commit, so the
// component's own focus-scroll logic runs and can be asserted directly.
vi.mock('vaul', async () => {
  const React = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  const passthrough = ({ children }: Props): React.ReactNode => children;
  const asDiv = ({ children, onOpenAutoFocus: _drop, ...rest }: Props): React.ReactNode =>
    React.createElement('div', rest, children);
  const asButton = ({ children, ...rest }: Props): React.ReactNode =>
    React.createElement('button', { type: 'button', ...rest }, children);
  return {
    Drawer: {
      Root: passthrough,
      Portal: passthrough,
      Overlay: asDiv,
      Content: asDiv,
      Title: ({ children }: Props): React.ReactNode => React.createElement('span', null, children),
      Close: asButton,
    },
  };
});

const { OverlayBottomSheet } = await import('./overlay-bottom-sheet');

const dispatchFocusIn = (element: Element): void => {
  element.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
};

describe('OverlayBottomSheet keyboard-aware focus scrolling', () => {
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    scrollIntoView.mockReset();
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  it('scrolls a focused input into view after the keyboard settle delay', async () => {
    render(
      <OverlayBottomSheet open={true} onOpenChange={vi.fn()} ariaLabel="Test sheet">
        <input aria-label="field" />
      </OverlayBottomSheet>
    );
    dispatchFocusIn(screen.getByLabelText('field'));
    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
    });
  });

  it('does not scroll when a non-field element is focused', async () => {
    render(
      <OverlayBottomSheet open={true} onOpenChange={vi.fn()} ariaLabel="Test sheet">
        <button type="button">Not a field</button>
        <input aria-label="real-field" />
      </OverlayBottomSheet>
    );
    dispatchFocusIn(screen.getByRole('button', { name: 'Not a field' }));
    dispatchFocusIn(screen.getByLabelText('real-field'));
    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    });
  });

  it('does not attach the listener while closed', () => {
    render(
      <OverlayBottomSheet open={false} onOpenChange={vi.fn()} ariaLabel="Test sheet">
        <input aria-label="closed-field" />
      </OverlayBottomSheet>
    );
    dispatchFocusIn(screen.getByLabelText('closed-field'));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
