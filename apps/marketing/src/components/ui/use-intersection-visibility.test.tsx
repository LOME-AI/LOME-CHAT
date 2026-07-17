import * as React from 'react';
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useIntersectionVisibility } from './use-intersection-visibility';

function TestComponent({ animated }: Readonly<{ animated: boolean }>): React.JSX.Element {
  const { containerRef, visible } = useIntersectionVisibility(animated);
  return <div ref={containerRef} data-testid="container" data-visible={String(visible)} />;
}

describe('useIntersectionVisibility', () => {
  let observeMock: ReturnType<typeof vi.fn>;
  let disconnectMock: ReturnType<typeof vi.fn>;
  let observerCallback: IntersectionObserverCallback;

  beforeEach(() => {
    observeMock = vi.fn();
    disconnectMock = vi.fn();

    vi.stubGlobal(
      'IntersectionObserver',
      vi.fn(function MockIntersectionObserver(callback: IntersectionObserverCallback) {
        observerCallback = callback;
        return {
          observe: observeMock,
          disconnect: disconnectMock,
          unobserve: vi.fn(),
        };
      })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns visible=false initially when animated=true', () => {
    render(<TestComponent animated={true} />);

    expect(screen.getByTestId('container')).toHaveAttribute('data-visible', 'false');
  });

  it('returns visible=true when not animated', () => {
    render(<TestComponent animated={false} />);

    expect(screen.getByTestId('container')).toHaveAttribute('data-visible', 'true');
  });

  it('sets visible=true when intersection observer triggers', () => {
    render(<TestComponent animated={true} />);

    expect(screen.getByTestId('container')).toHaveAttribute('data-visible', 'false');

    act(() => {
      observerCallback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    });

    expect(screen.getByTestId('container')).toHaveAttribute('data-visible', 'true');
  });

  it('observes the container element when animated', () => {
    render(<TestComponent animated={true} />);

    expect(observeMock).toHaveBeenCalledWith(screen.getByTestId('container'));
  });

  it('disconnects observer after element becomes visible', () => {
    render(<TestComponent animated={true} />);

    act(() => {
      observerCallback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    });

    expect(disconnectMock).toHaveBeenCalled();
  });

  it('disconnects observer on unmount', () => {
    const { unmount } = render(<TestComponent animated={true} />);

    unmount();

    expect(disconnectMock).toHaveBeenCalled();
  });

  it('does not create observer when animated is false', () => {
    render(<TestComponent animated={false} />);

    expect(observeMock).not.toHaveBeenCalled();
  });

  it('is a no-op when the container ref is never attached to an element', () => {
    function DetachedComponent(): React.JSX.Element {
      // Deliberately ignore containerRef so `containerRef.current` stays null
      // when the effect runs — exercising the null-element guard.
      const { visible } = useIntersectionVisibility(true);
      return <div data-testid="detached" data-visible={String(visible)} />;
    }

    render(<DetachedComponent />);

    expect(observeMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('detached')).toHaveAttribute('data-visible', 'false');
  });

  it('does not set visible when entry is not intersecting', () => {
    render(<TestComponent animated={true} />);

    act(() => {
      observerCallback(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    });

    expect(screen.getByTestId('container')).toHaveAttribute('data-visible', 'false');
  });
});
